import { z } from "zod";

type Environment = Record<string, string | undefined>;

const boundedFraction = z.coerce.number().finite().min(0).max(1);

const alertPolicyEnvironmentSchema = z
	.object({
		OBSERVABILITY_ASK_MIN_SAMPLES: z.coerce
			.number()
			.int()
			.min(1)
			.max(10_000)
			.default(10),
		OBSERVABILITY_ASK_FAILURE_RATE_WARNING: boundedFraction.default(0.05),
		OBSERVABILITY_ASK_CITATION_COVERAGE_MIN: boundedFraction.default(0.9),
		OBSERVABILITY_ASK_P95_WARNING_MS: z.coerce
			.number()
			.int()
			.min(1_000)
			.max(300_000)
			.default(15_000),
		OBSERVABILITY_ASK_P95_CRITICAL_MS: z.coerce
			.number()
			.int()
			.min(1_000)
			.max(600_000)
			.default(25_000),
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
	askMinSamples: 10,
	askFailureRateWarning: 0.05,
	askCitationCoverageMinimum: 0.9,
	askP95WarningMs: 15_000,
	askP95CriticalMs: 25_000,
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
