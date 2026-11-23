import { z } from "zod";
import {
	DEFAULT_ASK_ALERT_THRESHOLDS,
	type WorkspaceAlertThresholds,
} from "../../lib/workspace-notifications";

type Environment = Record<string, string | undefined>;

const boundedFraction = z.coerce.number().finite().min(0).max(1);

const alertPolicyEnvironmentSchema = z
	.object({
		OBSERVABILITY_ASK_MIN_SAMPLES: z.coerce
			.number()
			.int()
			.min(1)
			.max(10_000)
			.default(DEFAULT_ASK_ALERT_THRESHOLDS.ask_min_samples),
		OBSERVABILITY_ASK_FAILURE_RATE_WARNING: boundedFraction.default(
			DEFAULT_ASK_ALERT_THRESHOLDS.ask_failure_rate_warning,
		),
		OBSERVABILITY_ASK_CITATION_COVERAGE_MIN: boundedFraction.default(
			DEFAULT_ASK_ALERT_THRESHOLDS.ask_citation_coverage_min,
		),
		OBSERVABILITY_ASK_P95_WARNING_MS: z.coerce
			.number()
			.int()
			.min(1_000)
			.max(300_000)
			.default(DEFAULT_ASK_ALERT_THRESHOLDS.ask_p95_warning_ms),
		OBSERVABILITY_ASK_P95_CRITICAL_MS: z.coerce
			.number()
			.int()
			.min(1_000)
			.max(600_000)
			.default(DEFAULT_ASK_ALERT_THRESHOLDS.ask_p95_critical_ms),
		OBSERVABILITY_ALERT_RECOVERY_CYCLES: z.coerce
			.number()
			.int()
			.min(1)
			.max(10)
			.default(2),
	})
	.passthrough()
	.superRefine((value, context) => {
		if (
			value.OBSERVABILITY_ASK_P95_CRITICAL_MS <=
			value.OBSERVABILITY_ASK_P95_WARNING_MS
		) {
			context.addIssue({
				code: "custom",
				path: ["OBSERVABILITY_ASK_P95_CRITICAL_MS"],
				message:
					"OBSERVABILITY_ASK_P95_CRITICAL_MS must be greater than OBSERVABILITY_ASK_P95_WARNING_MS",
			});
		}
	});

export interface AlertPolicy {
	askMinSamples: number;
	askFailureRateWarning: number;
	askCitationCoverageMinimum: number;
	askP95WarningMs: number;
	askP95CriticalMs: number;
	recoveryCycles: number;
}

export const DEFAULT_ALERT_POLICY: AlertPolicy = {
	askMinSamples: DEFAULT_ASK_ALERT_THRESHOLDS.ask_min_samples,
	askFailureRateWarning: DEFAULT_ASK_ALERT_THRESHOLDS.ask_failure_rate_warning,
	askCitationCoverageMinimum:
		DEFAULT_ASK_ALERT_THRESHOLDS.ask_citation_coverage_min,
	askP95WarningMs: DEFAULT_ASK_ALERT_THRESHOLDS.ask_p95_warning_ms,
	askP95CriticalMs: DEFAULT_ASK_ALERT_THRESHOLDS.ask_p95_critical_ms,
	recoveryCycles: 2,
};

export function resolveAlertPolicy(
	environment: Environment = process.env,
): AlertPolicy {
	const parsed = alertPolicyEnvironmentSchema.parse(environment);
	return {
		askMinSamples: parsed.OBSERVABILITY_ASK_MIN_SAMPLES,
		askFailureRateWarning: parsed.OBSERVABILITY_ASK_FAILURE_RATE_WARNING,
		askCitationCoverageMinimum: parsed.OBSERVABILITY_ASK_CITATION_COVERAGE_MIN,
		askP95WarningMs: parsed.OBSERVABILITY_ASK_P95_WARNING_MS,
		askP95CriticalMs: parsed.OBSERVABILITY_ASK_P95_CRITICAL_MS,
		recoveryCycles: parsed.OBSERVABILITY_ALERT_RECOVERY_CYCLES,
	};
}

export function workspaceAlertDefaults(policy = resolveAlertPolicy()) {
	return {
		ask_min_samples: policy.askMinSamples,
		ask_failure_rate_warning: policy.askFailureRateWarning,
		ask_citation_coverage_min: policy.askCitationCoverageMinimum,
		ask_p95_warning_ms: policy.askP95WarningMs,
		ask_p95_critical_ms: policy.askP95CriticalMs,
	};
}

export function resolveWorkspaceAlertPolicy(
	overrides: WorkspaceAlertThresholds,
	baseline: AlertPolicy,
): AlertPolicy {
	const warning = overrides.ask_p95_warning_ms ?? baseline.askP95WarningMs;
	const critical = overrides.ask_p95_critical_ms ?? baseline.askP95CriticalMs;
	// If inherited latency thresholds drift after a deployment change, keep the
	// workspace's explicit value and restore a valid boundary for this cycle.
	return {
		askMinSamples: overrides.ask_min_samples ?? baseline.askMinSamples,
		askFailureRateWarning:
			overrides.ask_failure_rate_warning ?? baseline.askFailureRateWarning,
		askCitationCoverageMinimum:
			overrides.ask_citation_coverage_min ??
			baseline.askCitationCoverageMinimum,
		askP95WarningMs:
			overrides.ask_p95_warning_ms ?? Math.min(warning, critical),
		askP95CriticalMs:
			overrides.ask_p95_critical_ms ?? Math.max(critical, warning),
		recoveryCycles: baseline.recoveryCycles,
	};
}
