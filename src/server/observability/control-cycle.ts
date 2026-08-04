import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import * as schema from "@/db/schema";

import {
	claimAlertDeliveries,
	configuredAlertDestinations,
	deliverClaimedAlert,
	deriveOperationalSignals,
	reconcileWorkspaceAlerts,
	withAlertEvaluatorLock,
} from "./alerting";
import { OperationsService } from "./operations-service";
import { readProviderHealth } from "./provider-health";

export interface ObservabilityCycleResult {
	evaluated: boolean;
	workspaces: number;
	opened: number;
	resolved: number;
	observed: number;
	deliveries: {
		claimed: number;
		sent: number;
		retry: number;
		dead: number;
		stale: number;
	};
}

async function projectComponentHealth(
	pool: Pool,
	input: {
		organizationId: string;
		workspaceId: string;
		checkedAt: Date;
		items: Awaited<ReturnType<typeof readProviderHealth>>["items"];
	},
): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		for (const item of input.items) {
			await client.query(
				`INSERT INTO app.observability_component_health
					(organization_id, workspace_id, code, label, kind, status, mode,
					 latency_ms, error_code, recovery, checked_at, last_success_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
				 ON CONFLICT (organization_id, workspace_id, code) DO UPDATE
				 SET label = EXCLUDED.label, kind = EXCLUDED.kind,
					 status = EXCLUDED.status, mode = EXCLUDED.mode,
					 latency_ms = EXCLUDED.latency_ms,
					 error_code = EXCLUDED.error_code, recovery = EXCLUDED.recovery,
					 checked_at = EXCLUDED.checked_at,
					 last_success_at = CASE
						 WHEN EXCLUDED.status = 'healthy' THEN EXCLUDED.checked_at
						 ELSE app.observability_component_health.last_success_at
					 END,
					 updated_at = EXCLUDED.checked_at`,
				[
					input.organizationId,
					input.workspaceId,
					item.code,
					item.label,
					item.kind,
					item.status,
					item.mode,
					item.latency_ms,
					item.error_code,
					item.recovery,
					input.checkedAt,
					item.status === "healthy" ? input.checkedAt : null,
				],
			);
		}
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

export async function runObservabilityCycle(
	pool: Pool,
	input: {
		workerId: string;
		now?: Date;
		environment?: Record<string, string | undefined>;
	} = { workerId: "dbos-control" },
): Promise<ObservabilityCycleResult> {
	const now = input.now ?? new Date();
	const environment = input.environment ?? process.env;
	const base: ObservabilityCycleResult = {
		evaluated: false,
		workspaces: 0,
		opened: 0,
		resolved: 0,
		observed: 0,
		deliveries: { claimed: 0, sent: 0, retry: 0, dead: 0, stale: 0 },
	};
	const evaluation = await withAlertEvaluatorLock(pool, async () => {
		const scopes = await pool.query<{
			organization_id: string;
			workspace_id: string;
		}>(
			`SELECT organization_id, id AS workspace_id
			 FROM app.workspaces
			 WHERE status = 'active'
			 ORDER BY organization_id, id`,
		);
		const providers = await readProviderHealth(
			{ checkDatabase: async () => void (await pool.query("SELECT 1")) },
			{ now, environment },
		);
		const db = drizzle(pool, { schema });
		const service = OperationsService.fromDatabase(db);
		const destinations = configuredAlertDestinations(environment);
		const counts = { opened: 0, resolved: 0, observed: 0 };
		for (const scope of scopes.rows) {
			await projectComponentHealth(pool, {
				organizationId: scope.organization_id,
				workspaceId: scope.workspace_id,
				checkedAt: now,
				items: providers.items,
			});
			const snapshot = await service.readSnapshot(
				{
					organizationId: scope.organization_id,
					workspaceId: scope.workspace_id,
				},
				{ now },
			);
			const result = await reconcileWorkspaceAlerts(pool, {
				organizationId: scope.organization_id,
				workspaceId: scope.workspace_id,
				signals: deriveOperationalSignals(snapshot, providers),
				destinations,
				now,
			});
			counts.opened += result.opened;
			counts.resolved += result.resolved;
			counts.observed += result.observed;
		}
		return { workspaces: scopes.rowCount ?? scopes.rows.length, ...counts };
	});
	if (evaluation) Object.assign(base, evaluation, { evaluated: true });

	for (let processed = 0; processed < 20; processed += 1) {
		const operationNow = input.now ?? new Date();
		const [delivery] = await claimAlertDeliveries(pool, {
			workerId: input.workerId,
			limit: 1,
			now: operationNow,
		});
		if (!delivery) break;
		base.deliveries.claimed += 1;
		const status = await deliverClaimedAlert(pool, delivery, {
			environment,
			now: input.now ?? new Date(),
		});
		base.deliveries[status] += 1;
	}
	return base;
}
