import { and, desc, eq, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { projectAnswerCitationDiagnostic } from "@/core/ai/answer-citations";
import { projectRerankDiagnostic } from "@/core/retrieval/provider-request";
import { projectQdrantDiagnostic } from "@/core/retrieval/qdrant/diagnostics";

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
import type {
	JudgeDiagnosticDetail,
	JudgeErrorCategory,
	OperationsEventDetail,
} from "@/lib/operations-event-detail";
import { operationalRefusalCode } from "@/lib/operations-event-detail";

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

const judgeErrorCategories = new Set<string>([
	"timeout",
	"authentication",
	"rate_limit",
	"provider_unavailable",
	"output_truncated",
	"invalid_output",
	"provider_error",
	"evidence_validation",
	"unknown",
] satisfies JudgeErrorCategory[]);

const judgeFailureSources = new Set([
	"structured_request",
	"evidence_validation",
	"unknown",
]);
const judgeFailureStages = new Set([
	"judge",
	"refusal_review",
	"conflict",
	"selected_ids",
	"conflict_provenance",
	"source_count",
]);
const judgeValidationCodes = new Set([
	"selected_ids_empty",
	"selected_ids_unknown",
	"selected_ids_ambiguous",
	"conflict_schema",
	"conflict_unknown_source",
	"conflict_quote_mismatch",
	"conflict_duplicate_quote",
	"source_count_exceeded",
]);

function judgeDetail(
	stage: typeof askRunStages.$inferSelect,
): JudgeDiagnosticDetail | null {
	if (
		stage.stage !== "judge" ||
		stage.outcome !== "failed" ||
		stage.errorCode !== "judge_unavailable" ||
		!stage.detail ||
		typeof stage.detail !== "object" ||
		Array.isArray(stage.detail)
	)
		return null;

	const detail: JudgeDiagnosticDetail = {};
	const category = stage.detail.judge_error_category;
	if (typeof category === "string" && judgeErrorCategories.has(category)) {
		detail.judge_error_category = category as JudgeErrorCategory;
	}
	const source = stage.detail.judge_failure_source;
	if (typeof source === "string" && judgeFailureSources.has(source))
		detail.judge_failure_source =
			source as JudgeDiagnosticDetail["judge_failure_source"];
	const failedStage = stage.detail.judge_failed_stage;
	if (typeof failedStage === "string" && judgeFailureStages.has(failedStage))
		detail.judge_failed_stage =
			failedStage as JudgeDiagnosticDetail["judge_failed_stage"];
	const validation = stage.detail.judge_validation_code;
	if (typeof validation === "string" && judgeValidationCodes.has(validation))
		detail.judge_validation_code =
			validation as JudgeDiagnosticDetail["judge_validation_code"];
	for (const key of [
		"judge_attempts",
		"judge_max_attempts",
		"judge_sufficiency_attempts",
		"judge_refusal_review_attempts",
		"judge_conflict_attempts",
	] as const) {
		const value = stage.detail[key];
		if (
			typeof value === "number" &&
			Number.isSafeInteger(value) &&
			value >= 0
		) {
			detail[key] = value;
		}
	}
	for (const key of [
		"judge_duration_ms",
		"judge_timeout_ms",
		"judge_budget_ms",
		"judge_sufficiency_duration_ms",
		"judge_refusal_review_duration_ms",
		"judge_conflict_duration_ms",
	] as const) {
		const value = stage.detail[key];
		if (
			typeof value === "number" &&
			Number.isFinite(value) &&
			value >= 0 &&
			value <= Number.MAX_SAFE_INTEGER
		) {
			detail[key] = value;
		}
	}
	const status = stage.detail.judge_status_code;
	if (
		typeof status === "number" &&
		Number.isInteger(status) &&
		status >= 100 &&
		status <= 599
	) {
		detail.judge_status_code = status;
	}
	if (typeof stage.detail.judge_retryable === "boolean") {
		detail.judge_retryable = stage.detail.judge_retryable;
	}
	return Object.keys(detail).length > 0 ? detail : null;
}

function stageDetail(stage: typeof askRunStages.$inferSelect) {
	const citation = projectAnswerCitationDiagnostic({
		category: stage.detail?.citation_category,
		allowedSourceCount: stage.detail?.citation_allowedSourceCount,
	});
	const qdrant = projectQdrantDiagnostic(
		Object.fromEntries(
			Object.entries(stage.detail ?? {})
				.filter(([key]) => key.startsWith("qdrant_"))
				.map(([key, value]) => [key.slice(7), value]),
		),
	);
	const dependency = {
		...(qdrant ? { qdrant } : {}),
		...(citation ? { citation } : {}),
	};
	if (stage.stage !== "retrieve" && stage.stage !== "table_retrieve") {
		const judge = judgeDetail(stage);
		return judge || qdrant || citation ? { ...judge, ...dependency } : null;
	}
	const rerank = projectRerankDiagnostic(
		Object.fromEntries(
			Object.entries(stage.detail ?? {})
				.filter(([key]) => key.startsWith("rerank_"))
				.map(([key, value]) => [key.slice(7), value]),
		),
	);
	return rerank || qdrant || citation
		? { ...(rerank ? { rerank } : {}), ...dependency }
		: null;
}

export class OperationsEventService {
	constructor(private readonly db: Database) {}

	async read(
		scope: OperationsEventScope,
		source: "ask" | "job",
		id: string,
	): Promise<OperationsEventDetail | null> {
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
			ask: {
				refuse_reason: operationalRefusalCode(run.refuseReason),
				citation_count: run.citationCount,
				used_hybrid: run.usedHybrid,
				used_rerank: run.usedRerank,
			},
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
				detail: stageDetail(stage),
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
			can_retry:
				event.job.type === "document.delete" &&
				["failed", "dead", "cancelled"].includes(event.job.status) &&
				event.document?.status === "deleting" &&
				event.document.latestJobId === event.job.id,
			stages: stages.map(jobStage),
		};
	}
}
