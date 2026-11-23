import { z } from "zod";

export const workspaceEmailSettingsSchema = z
	.strictObject({
		enabled: z.boolean(),
		recipients: z
			.array(z.string().trim().toLowerCase().pipe(z.email().max(254)))
			.max(5)
			.transform((values) => [...new Set(values)].sort()),
		minimum_severity: z.enum(["warning", "critical"]),
		notify_recovery: z.boolean(),
	})
	.refine((value) => !value.enabled || value.recipients.length > 0, {
		message: "启用邮件通知前请添加收件邮箱",
		path: ["recipients"],
	});

export type WorkspaceEmailSettings = z.infer<
	typeof workspaceEmailSettingsSchema
>;

export const DEFAULT_WORKSPACE_EMAIL_SETTINGS: WorkspaceEmailSettings = {
	enabled: false,
	recipients: [],
	minimum_severity: "warning",
	notify_recovery: true,
};

export const DEFAULT_ASK_ALERT_THRESHOLDS = {
	ask_min_samples: 10,
	ask_failure_rate_warning: 0.05,
	ask_citation_coverage_min: 0.9,
	ask_p95_warning_ms: 15_000,
	ask_p95_critical_ms: 25_000,
};

export const workspaceAlertThresholdsSchema = z
	.strictObject({
		ask_min_samples: z.number().int().min(1).max(1_000),
		ask_failure_rate_warning: z.number().min(0.01).max(1),
		ask_citation_coverage_min: z.number().min(0.1).max(1),
		ask_p95_warning_ms: z.number().int().min(1_000).max(120_000),
		ask_p95_critical_ms: z.number().int().min(1_000).max(300_000),
	})
	.partial()
	.refine(
		(value) =>
			value.ask_p95_warning_ms === undefined ||
			value.ask_p95_critical_ms === undefined ||
			value.ask_p95_critical_ms >= value.ask_p95_warning_ms,
		{
			path: ["ask_p95_critical_ms"],
			message: "Critical must be at least warning",
		},
	);

export type WorkspaceAlertThresholds = z.infer<
	typeof workspaceAlertThresholdsSchema
>;

export const workspaceNotificationsPatchSchema = z
	.strictObject({
		version: z.number().int().min(0).optional(),
		settings: workspaceEmailSettingsSchema.optional(),
		alert_thresholds: workspaceAlertThresholdsSchema.optional(),
		alert_policy_version: z.number().int().min(0).optional(),
	})
	.refine(
		(value) =>
			(value.settings !== undefined || value.alert_thresholds !== undefined) &&
			(value.settings === undefined) === (value.version === undefined) &&
			(value.alert_thresholds === undefined) ===
				(value.alert_policy_version === undefined),
	);

export type WorkspaceNotificationsPatch = z.infer<
	typeof workspaceNotificationsPatchSchema
>;

export type WorkspaceAlertThresholdDefaults =
	typeof DEFAULT_ASK_ALERT_THRESHOLDS;

export function workspaceAlertLatencyOrderIsValid(
	thresholds: WorkspaceAlertThresholds,
	defaults: WorkspaceAlertThresholdDefaults,
): boolean {
	return (
		(thresholds.ask_p95_critical_ms ?? defaults.ask_p95_critical_ms) >=
		(thresholds.ask_p95_warning_ms ?? defaults.ask_p95_warning_ms)
	);
}

export type WorkspaceNotificationScope = {
	organizationId: string;
	workspaceId: string;
};

export type EmailTransportState = {
	status: "configured" | "unconfigured" | "unknown";
	checked_at: string | null;
};

export type EmailDeliveryView = {
	id: string;
	purpose: "alert" | "test";
	recipient: string | null;
	status: "pending" | "sending" | "retry" | "sent" | "dead";
	attempt: number;
	max_attempts: number;
	error_code: string | null;
	created_at: string;
	delivered_at: string | null;
	next_attempt_at: string;
	provider_message_id: string | null;
};

export type WorkspaceNotificationsView = {
	settings: WorkspaceEmailSettings;
	version: number;
	alert_thresholds: WorkspaceAlertThresholds;
	alert_defaults: WorkspaceAlertThresholdDefaults;
	alert_policy_version: number;
	updated_at: string | null;
	transport: EmailTransportState;
	deliveries: EmailDeliveryView[];
};
