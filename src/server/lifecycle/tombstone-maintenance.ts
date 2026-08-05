import type { ObservabilityLogger } from "@/lib/observability";

import type { TombstoneMaintenanceRepository } from "./tombstone-repository";

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface TombstoneMaintenanceOptions {
	execute: boolean;
	retentionDays: number;
	limit: number;
	now?: Date;
}

export interface TombstoneMaintenanceResult {
	mode: "dry_run" | "execute";
	documents: { candidates: number; purged: number };
	libraries: { candidates: number; purged: number; blocked: number };
	ok: boolean;
}

export async function runTombstoneMaintenance(
	options: TombstoneMaintenanceOptions,
	dependencies: {
		repository: TombstoneMaintenanceRepository;
		logger: ObservabilityLogger;
	},
): Promise<TombstoneMaintenanceResult> {
	const now = options.now ?? new Date();
	if (Number.isNaN(now.getTime())) throw new Error("now must be a valid date");
	if (
		!Number.isSafeInteger(options.retentionDays) ||
		options.retentionDays <= 0
	) {
		throw new Error("retentionDays must be a positive integer");
	}
	if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
		throw new Error("limit must be a positive integer");
	}
	const before = new Date(now.getTime() - options.retentionDays * DAY_MS);
	const mode = options.execute ? "execute" : "dry_run";
	dependencies.logger.info({
		event: "tombstone_maintenance_started",
		mode,
		retention_days: options.retentionDays,
		before: before.toISOString(),
		limit: options.limit,
	});

	if (!options.execute) {
		const [documents, libraries, blocked] = await Promise.all([
			dependencies.repository.countExpiredDocuments({
				before,
				limit: options.limit,
			}),
			dependencies.repository.countPurgeableLibraries({
				before,
				limit: options.limit,
			}),
			dependencies.repository.countBlockedLibraries({
				before,
				limit: options.limit,
			}),
		]);
		const result: TombstoneMaintenanceResult = {
			mode,
			documents: { candidates: documents, purged: 0 },
			libraries: { candidates: libraries, purged: 0, blocked },
			ok: true,
		};
		logFinished(dependencies.logger, result);
		return result;
	}

	const purgedDocuments = await dependencies.repository.purgeExpiredDocuments({
		before,
		limit: options.limit,
	});
	const blocked = await dependencies.repository.countBlockedLibraries({
		before,
		limit: options.limit,
	});
	// Document purging can make a deleted library eligible in the same cycle.
	const purgedLibraries = await dependencies.repository.purgeExpiredLibraries({
		before,
		limit: options.limit,
	});
	const result: TombstoneMaintenanceResult = {
		mode,
		documents: {
			candidates: purgedDocuments,
			purged: purgedDocuments,
		},
		libraries: {
			candidates: purgedLibraries,
			purged: purgedLibraries,
			blocked,
		},
		ok: true,
	};
	logFinished(dependencies.logger, result);
	return result;
}

function logFinished(
	logger: ObservabilityLogger,
	result: TombstoneMaintenanceResult,
): void {
	logger.info({
		event: "tombstone_maintenance_finished",
		mode: result.mode,
		ok: result.ok,
		documents_candidates: result.documents.candidates,
		documents_purged: result.documents.purged,
		libraries_candidates: result.libraries.candidates,
		libraries_purged: result.libraries.purged,
		libraries_blocked: result.libraries.blocked,
	});
}
