import { and, desc, eq, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type * as schema from "@/db/schema";
import {
	askRunStages,
	askRuns,
	auditLogs,
	documents,
	documentVersions,
	jobStageRuns,
	jobs,
	libraries,
} from "@/db/schema";
import {
	errorGuidance,
	redactDiagnosticMessage,
} from "@/lib/error-diagnostics";

type Database = NodePgDatabase<typeof schema>;

export interface OperationsEventScope {
	organizationId: string;
	workspaceId: string;
}

function iso(value: Date | null): string | null {
	return value?.toISOString() ?? null;
}

function jobStage(row: typeof jobStageRuns.$inferSelect) {
	return {
		id: row.id,
		sequence: row.sequence,
		attempt: row.attempt,
		stage: row.stage,
		outcome: row.outcome,
		error_code: row.errorCode,
		started_at: row.startedAt.toISOString(),
		ended_at: iso(row.endedAt),
		duration_ms: row.durationMs,
	};
}

export class OperationsEventService {
	constructor(private readonly db: Database) {}

	async read(scope: OperationsEventScope, source: "ask" | "job", id: string) {
		return source === "ask" ? this.readAsk(scope, id) : this.readJob(scope, id);
	}

	private async readAsk(scope: OperationsEventScope, id: string) {
		const [run] = await this.db
			.select()
			.from(askRuns)
			.where(
				and(
					eq(askRuns.id, id),
					eq(askRuns.organizationId, scope.organizationId),
					eq(askRuns.workspaceId, scope.workspaceId),
				),
			)
			.limit(1);
		if (!run) return null;
		const stages = await this.db
			.select()
			.from(askRunStages)
			.where(eq(askRunStages.askRunId, run.id))
			.orderBy(askRunStages.sequence);
		const failedStage = [...stages]
			.reverse()
			.find((stage) => stage.outcome === "failed" && stage.errorCode);
		const code =
			run.errorCode ?? failedStage?.errorCode ?? "unclassified_error";
		return {
			source: "ask" as const,
			id: run.id,
			status: run.status,
			error_code: run.errorCode ?? failedStage?.errorCode ?? null,
			guidance: errorGuidance(code),
			request_id: run.requestId,
			otel_trace_id: run.otelTraceId,
			workflow_id: null,
			library_id: run.ragLibraryId,
			document_id: null,
			document_version_id: null,
			query_type: run.queryType,
			retrieval_mode: run.retrievalMode,
			started_at: run.startedAt.toISOString(),
			ended_at: iso(run.endedAt),
			latency_ms: run.latencyMs,
			message: null,
			stages: stages.map((stage) => ({
				id: stage.id,
				sequence: stage.sequence,
				attempt: null,
				stage: stage.stage,
				outcome: stage.outcome,
				error_code: stage.errorCode,
				started_at: null,
				ended_at: null,
				duration_ms: stage.durationMs,
			})),
		};
	}

	private async readJob(scope: OperationsEventScope, stageRunId: string) {
		const [event] = await this.db
			.select({
				stageRun: jobStageRuns,
				job: jobs,
				version: documentVersions,
				document: documents,
				library: libraries,
			})
			.from(jobStageRuns)
			.innerJoin(jobs, eq(jobs.id, jobStageRuns.jobId))
			.leftJoin(
				documentVersions,
				eq(documentVersions.id, jobs.documentVersionId),
			)
			.leftJoin(documents, eq(documents.id, documentVersions.documentId))
			.leftJoin(libraries, eq(libraries.id, documents.libraryId))
			.where(
				and(
					eq(jobStageRuns.id, stageRunId),
					eq(jobStageRuns.organizationId, scope.organizationId),
					eq(jobStageRuns.workspaceId, scope.workspaceId),
				),
			)
			.limit(1);
		if (!event) return null;
		const [stages, audits] = await Promise.all([
			this.db
				.select()
				.from(jobStageRuns)
				.where(eq(jobStageRuns.jobId, event.job.id))
				.orderBy(jobStageRuns.sequence),
			this.db
				.select({ requestId: auditLogs.requestId })
				.from(auditLogs)
				.where(
					and(
						eq(auditLogs.organizationId, scope.organizationId),
						eq(auditLogs.workspaceId, scope.workspaceId),
						or(
							eq(auditLogs.resourceId, event.job.id),
							sql`${auditLogs.details} ->> 'job_id' = ${event.job.id}`,
						),
					),
				)
				.orderBy(desc(auditLogs.createdAt))
				.limit(1),
		]);
		const code =
			event.stageRun.errorCode ?? event.job.errorCode ?? "unclassified_error";
		return {
			source: "job" as const,
			id: event.stageRun.id,
			resource_id: event.job.id,
			status: event.stageRun.outcome,
			error_code: event.stageRun.errorCode ?? event.job.errorCode,
			guidance: errorGuidance(code),
			request_id: audits[0]?.requestId ?? null,
			otel_trace_id: null,
			workflow_id: event.job.workflowId,
			library_id: event.library?.ragLibraryId ?? null,
			document_id: event.document?.ragDocumentId ?? null,
			document_version_id: event.version?.id ?? event.job.documentVersionId,
			query_type: null,
			retrieval_mode: null,
			started_at:
				event.job.startedAt?.toISOString() ?? event.job.createdAt.toISOString(),
			ended_at: iso(event.job.finishedAt),
			latency_ms:
				event.job.finishedAt && event.job.startedAt
					? Math.max(
							0,
							event.job.finishedAt.getTime() - event.job.startedAt.getTime(),
						)
					: null,
			message: redactDiagnosticMessage(event.job.error),
			stages: stages.map(jobStage),
		};
	}
}
