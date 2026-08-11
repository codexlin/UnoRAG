import { NextResponse } from "next/server";

import { getDatabase } from "@/db";
import { resolveReleaseInfo } from "@/lib/release-info";
import { resolveRequestSession } from "@/lib/server/auth/session";
import { canManageMembers } from "@/lib/server/workspace-permissions.mjs";
import { OperationsService } from "@/server/observability/operations-service";

function optionalNumber(value: string | null): number | undefined {
	if (value === null || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function enabled(value: string | undefined): boolean {
	return value?.trim().toLowerCase() === "true" || value?.trim() === "1";
}

export async function GET(request: Request) {
	const identity = await resolveRequestSession(request);
	if (!identity) {
		return NextResponse.json(
			{ detail: "authentication required" },
			{ status: 401 },
		);
	}
	if (!canManageMembers(identity)) {
		return NextResponse.json({ detail: "forbidden" }, { status: 403 });
	}

	const url = new URL(request.url);
	const snapshot = await OperationsService.fromDatabase(
		getDatabase(),
	).readSnapshot(
		{
			organizationId: identity.tenantId,
			workspaceId: identity.workspaceId,
		},
		{
			windowHours: optionalNumber(url.searchParams.get("window_hours")),
			errorLimit: optionalNumber(url.searchParams.get("error_limit")),
			stuckAfterMinutes: optionalNumber(
				url.searchParams.get("stuck_after_minutes"),
			),
		},
	);
	const hasUnknown =
		snapshot.components.length === 0 ||
		snapshot.components.some((component) => component.status === "unknown");
	const hasCritical = snapshot.alerts.some(
		(alert) => alert.status === "active" && alert.severity === "critical",
	);
	const hasWarning = snapshot.alerts.some(
		(alert) => alert.status === "active" && alert.severity === "warning",
	);
	return NextResponse.json({
		...snapshot,
		release: resolveReleaseInfo(process.env),
		scope: { workspace_id: identity.workspaceId },
		overall: {
			status: hasCritical
				? "unavailable"
				: hasWarning
					? "degraded"
					: hasUnknown
						? "unknown"
						: "healthy",
			evaluated_at: snapshot.generated_at,
			stale: hasUnknown,
		},
		notifications: {
			webhook: enabled(process.env.OBSERVABILITY_ALERT_WEBHOOK_ENABLED),
			email: enabled(process.env.OBSERVABILITY_ALERT_EMAIL_ENABLED),
		},
	});
}
