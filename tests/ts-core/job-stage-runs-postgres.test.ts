import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "../../src/db/schema";
import { OperationsEventService } from "../../src/server/observability/operations-event-service";

const databaseUrl = process.env.DOCUMENT_INGEST_TEST_DATABASE_URL?.trim();

test("job stage trigger preserves failed attempt history after a successful retry job", {
	skip: databaseUrl
		? false
		: "DOCUMENT_INGEST_TEST_DATABASE_URL is not configured",
}, async () => {
	const pool = new Pool({ connectionString: databaseUrl });
	const db = drizzle(pool, { schema });
	const organizationId = randomUUID();
	const workspaceId = randomUUID();
	const otherWorkspaceId = randomUUID();
	const failedJobId = randomUUID();
	const retryJobId = randomUUID();
	try {
		await db.insert(schema.organizations).values({
			id: organizationId,
			slug: `stage-runs-${organizationId}`,
			name: "Stage runs integration",
		});
		await db.insert(schema.workspaces).values({
			id: workspaceId,
			organizationId,
			slug: `stage-runs-${workspaceId}`,
			name: "Stage runs integration",
		});
		await db.insert(schema.workspaces).values({
			id: otherWorkspaceId,
			organizationId,
			slug: `stage-runs-${otherWorkspaceId}`,
			name: "Other stage runs workspace",
		});
		await db.insert(schema.jobs).values({
			id: failedJobId,
			organizationId,
			workspaceId,
			type: "diagnostics.test",
			workflowId: failedJobId,
			idempotencyKey: `stage-runs-failed-${failedJobId}`,
		});
		await db
			.update(schema.jobs)
			.set({
				status: "running",
				stage: "downloading",
				attempt: 1,
				startedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(schema.jobs.id, failedJobId));
		await db
			.update(schema.jobs)
			.set({ stage: "parsing", progress: 15, updatedAt: new Date() })
			.where(eq(schema.jobs.id, failedJobId));
		await db
			.update(schema.jobs)
			.set({
				status: "failed",
				stage: "done",
				errorCode: "parser_timeout",
				error: "integration failure",
				finishedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(schema.jobs.id, failedJobId));

		await db.insert(schema.jobs).values({
			id: retryJobId,
			organizationId,
			workspaceId,
			type: "diagnostics.test",
			workflowId: retryJobId,
			idempotencyKey: `stage-runs-retry-${retryJobId}`,
		});
		await db
			.update(schema.jobs)
			.set({
				status: "running",
				stage: "downloading",
				attempt: 1,
				startedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(schema.jobs.id, retryJobId));
		await db
			.update(schema.jobs)
			.set({
				status: "completed",
				stage: "done",
				progress: 100,
				finishedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(schema.jobs.id, retryJobId));

		const failedStages = await db
			.select()
			.from(schema.jobStageRuns)
			.where(eq(schema.jobStageRuns.jobId, failedJobId))
			.orderBy(schema.jobStageRuns.sequence);
		assert.deepEqual(
			failedStages.map((stage) => [stage.stage, stage.outcome]),
			[
				["accepted", "completed"],
				["downloading", "completed"],
				["parsing", "failed"],
			],
		);
		assert.equal(failedStages.at(-1)?.errorCode, "parser_timeout");
		assert.equal(
			failedStages.every(
				(stage) => stage.durationMs != null && stage.durationMs >= 0,
			),
			true,
		);

		const service = new OperationsEventService(db);
		const detail = await service.read(
			{ organizationId, workspaceId },
			"job",
			failedStages.at(-1)?.id ?? "",
		);
		assert.equal(detail?.source, "job");
		if (detail?.source !== "job") {
			throw new Error("expected scoped job error detail");
		}
		assert.equal(detail.resource_id, failedJobId);
		assert.equal(detail.error_code, "parser_timeout");
		assert.equal(detail.guidance.title, "文档解析异常");
		assert.deepEqual(
			detail.stages.map((stage) => [stage.stage, stage.outcome]),
			[
				["accepted", "completed"],
				["downloading", "completed"],
				["parsing", "failed"],
			],
		);
		assert.equal(
			await service.read(
				{ organizationId, workspaceId: otherWorkspaceId },
				"job",
				failedStages.at(-1)?.id ?? "",
			),
			null,
		);

		const retryStages = await db
			.select()
			.from(schema.jobStageRuns)
			.where(
				and(
					eq(schema.jobStageRuns.jobId, retryJobId),
					eq(schema.jobStageRuns.outcome, "completed"),
				),
			);
		assert.equal(retryStages.length, 2);
	} finally {
		await db
			.delete(schema.organizations)
			.where(eq(schema.organizations.id, organizationId));
		await pool.end();
	}
});
