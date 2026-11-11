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
	updated_at: string | null;
	transport: EmailTransportState;
	deliveries: EmailDeliveryView[];
};
