import { NextResponse } from "next/server";

import { getDatabase } from "@/db";
import { resolveRequestSession } from "@/lib/server/auth/session";
import { canManageMembers } from "@/lib/server/workspace-permissions.mjs";
import { OperationsService } from "@/server/observability/operations-service";

function optionalNumber(value: string | null): number | undefined {
	if (value === null || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
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
	return NextResponse.json(snapshot);
}
