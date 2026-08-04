import type { ObservabilityLogger } from "@/lib/observability";

import {
	type AskRunsRepository,
	type AskRunWriteResult,
	STALE_ASK_RUN_CANCELLED_ERROR_CODE,
	STALE_ASK_RUN_FAILED_ERROR_CODE,
} from "./ask-runs-repository";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MINUTE_MS = 60 * 1_000;

export interface AskRunsMaintenanceOptions {
	execute: boolean;
	maintainStale: boolean;
	maintainRetention: boolean;
	staleAfterMinutes: number;
	retentionDays: number;
	staleStatus: "failed" | "cancelled";
	organizationId?: string;
	workspaceId?: string;
	userId?: string;
	limit: number;
	now?: Date;
}

export interface AskRunsMaintenanceResult {
	mode: "dry_run" | "execute";
	stale?: { candidates: number; changed: number };
	retention?: { candidates: number; changed: number };
	ok: boolean;
}

type MaintenanceRepository = Pick<
	AskRunsRepository,
	| "countStaleRunning"
	| "reconcileStaleRunning"
	| "countExpired"
	| "deleteExpired"
>;

export interface AskRunsMaintenanceDependencies {
	repository: MaintenanceRepository;
	logger: ObservabilityLogger;
}

function resultValue(result: AskRunWriteResult<number>): number {
	return result.ok ? result.value : 0;
}

export async function runAskRunsMaintenance(
	options: AskRunsMaintenanceOptions,
	dependencies: AskRunsMaintenanceDependencies,
): Promise<AskRunsMaintenanceResult> {
	const now = options.now ?? new Date();
	if (Number.isNaN(now.getTime())) throw new Error("now must be a valid date");
	const mode = options.execute ? "execute" : "dry_run";
	const result: AskRunsMaintenanceResult = { mode, ok: true };
	dependencies.logger.info({
		event: "ask_runs_maintenance_started",
		mode,
		maintain_stale: options.maintainStale,
		maintain_retention: options.maintainRetention,
		limit: options.limit,
		organization_id: options.organizationId,
		workspace_id: options.workspaceId,
		user_id: options.userId,
	});

	if (options.maintainStale) {
		const input = {
			before: new Date(now.getTime() - options.staleAfterMinutes * MINUTE_MS),
			status: options.staleStatus,
			errorCode:
				options.staleStatus === "failed"
					? STALE_ASK_RUN_FAILED_ERROR_CODE
					: STALE_ASK_RUN_CANCELLED_ERROR_CODE,
			limit: options.limit,
			endedAt: now,
		} as const;
		const operation = options.execute
			? await dependencies.repository.reconcileStaleRunning(input)
			: await dependencies.repository.countStaleRunning(input);
		result.stale = {
			candidates: resultValue(operation),
			changed: options.execute ? resultValue(operation) : 0,
		};
		if (!operation.ok) result.ok = false;
	}

	if (options.maintainRetention) {
		const input = {
			before: new Date(now.getTime() - options.retentionDays * DAY_MS),
			organizationId: options.organizationId,
			workspaceId: options.workspaceId,
			userId: options.userId,
			limit: options.limit,
		};
		const operation = options.execute
			? await dependencies.repository.deleteExpired(input)
			: await dependencies.repository.countExpired(input);
		result.retention = {
			candidates: resultValue(operation),
			changed: options.execute ? resultValue(operation) : 0,
		};
		if (!operation.ok) result.ok = false;
	}

	dependencies.logger.info({
		event: "ask_runs_maintenance_finished",
		...result,
	});
	return result;
}
