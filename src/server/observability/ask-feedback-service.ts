import { and, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type * as schema from "@/db/schema";
import { askFeedback, askRuns } from "@/db/schema";
import type {
	AskFeedbackRating,
	AskFeedbackReasonCode,
	AskFeedbackRecord,
	AskFeedbackTriageStatus,
	SubmitAskFeedbackInput,
	UpdateFeedbackTriageInput,
} from "@/lib/ask-feedback";

export type AskFeedbackUserScope = {
	organizationId: string;
	workspaceId: string;
	userId: string;
};

export type AskFeedbackWorkspaceScope = {
	organizationId: string;
	workspaceId: string;
};

export type ListAskFeedbackFilters = {
	rating?: AskFeedbackRating;
	triageStatus?: AskFeedbackTriageStatus;
	reasonCode?: AskFeedbackReasonCode;
	limit?: number;
};

export class AskFeedbackNotFoundError extends Error {
	constructor(message = "ask feedback target not found") {
		super(message);
		this.name = "AskFeedbackNotFoundError";
	}
}

export class AskFeedbackService {
	constructor(private readonly db: NodePgDatabase<typeof schema>) {}

	async submitFeedback(
		scope: AskFeedbackUserScope,
		input: SubmitAskFeedbackInput,
	): Promise<{
		id: string;
		request_id: string;
		rating: AskFeedbackRating;
		reason_code: AskFeedbackReasonCode | null;
		triage_status: AskFeedbackTriageStatus;
	}> {
		const [run] = await this.db
			.select({ id: askRuns.id, requestId: askRuns.requestId })
			.from(askRuns)
			.where(
				and(
					eq(askRuns.requestId, input.request_id),
					eq(askRuns.organizationId, scope.organizationId),
					eq(askRuns.workspaceId, scope.workspaceId),
					eq(askRuns.userId, scope.userId),
				),
			)
			.limit(1);

		if (!run) {
			throw new AskFeedbackNotFoundError("ask run not found in current scope");
		}

		const reasonCode =
			input.rating === "up" ? null : (input.reason_code ?? null);
		const triageStatus: AskFeedbackTriageStatus =
			input.rating === "up" ? "resolved" : "open";
		const now = new Date();

		const [saved] = await this.db
			.insert(askFeedback)
			.values({
				askRunId: run.id,
				requestId: run.requestId,
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				userId: scope.userId,
				rating: input.rating,
				reasonCode,
				triageStatus,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: [askFeedback.requestId, askFeedback.userId],
				set: {
					rating: input.rating,
					reasonCode,
					triageStatus,
					updatedAt: now,
				},
			})
			.returning({
				id: askFeedback.id,
				requestId: askFeedback.requestId,
				rating: askFeedback.rating,
				reasonCode: askFeedback.reasonCode,
				triageStatus: askFeedback.triageStatus,
			});

		return {
			id: saved.id,
			request_id: saved.requestId,
			rating: saved.rating as AskFeedbackRating,
			reason_code: (saved.reasonCode as AskFeedbackReasonCode | null) ?? null,
			triage_status: saved.triageStatus as AskFeedbackTriageStatus,
		};
	}

	async listFeedback(
		scope: AskFeedbackWorkspaceScope,
		filters: ListAskFeedbackFilters = {},
	): Promise<AskFeedbackRecord[]> {
		const limit = Math.min(Math.max(Math.trunc(filters.limit ?? 50), 1), 200);
		const conditions = [
			eq(askFeedback.organizationId, scope.organizationId),
			eq(askFeedback.workspaceId, scope.workspaceId),
		];
		if (filters.rating) {
			conditions.push(eq(askFeedback.rating, filters.rating));
		}
		if (filters.triageStatus) {
			conditions.push(eq(askFeedback.triageStatus, filters.triageStatus));
		}
		if (filters.reasonCode) {
			conditions.push(eq(askFeedback.reasonCode, filters.reasonCode));
		}

		const rows = await this.db
			.select({
				id: askFeedback.id,
				requestId: askFeedback.requestId,
				libraryId: askRuns.libraryId,
				queryType: askRuns.queryType,
				runStatus: askRuns.status,
				refuseReason: askRuns.refuseReason,
				citationCount: askRuns.citationCount,
				latencyMs: askRuns.latencyMs,
				usedHybrid: askRuns.usedHybrid,
				usedRerank: askRuns.usedRerank,
				rating: askFeedback.rating,
				reasonCode: askFeedback.reasonCode,
				triageStatus: askFeedback.triageStatus,
				createdAt: askFeedback.createdAt,
				updatedAt: askFeedback.updatedAt,
			})
			.from(askFeedback)
			.innerJoin(
				askRuns,
				and(
					eq(askFeedback.askRunId, askRuns.id),
					eq(askRuns.organizationId, scope.organizationId),
					eq(askRuns.workspaceId, scope.workspaceId),
				),
			)
			.where(and(...conditions))
			.orderBy(desc(askFeedback.updatedAt), desc(askFeedback.id))
			.limit(limit);

		return rows.map((row) => ({
			id: row.id,
			request_id: row.requestId,
			library_id: row.libraryId,
			query_type: row.queryType,
			run_status: row.runStatus,
			refuse_reason: row.refuseReason,
			citation_count: row.citationCount,
			latency_ms: row.latencyMs,
			used_hybrid: row.usedHybrid,
			used_rerank: row.usedRerank,
			rating: row.rating as AskFeedbackRating,
			reason_code: (row.reasonCode as AskFeedbackReasonCode | null) ?? null,
			triage_status: row.triageStatus as AskFeedbackTriageStatus,
			created_at: row.createdAt.toISOString(),
			updated_at: row.updatedAt.toISOString(),
		}));
	}

	async updateTriageStatus(
		scope: AskFeedbackWorkspaceScope,
		input: UpdateFeedbackTriageInput,
	): Promise<{
		id: string;
		triage_status: AskFeedbackTriageStatus;
		updated_at: string;
	}> {
		const [updated] = await this.db
			.update(askFeedback)
			.set({
				triageStatus: input.triage_status,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(askFeedback.id, input.feedback_id),
					eq(askFeedback.organizationId, scope.organizationId),
					eq(askFeedback.workspaceId, scope.workspaceId),
				),
			)
			.returning({
				id: askFeedback.id,
				triageStatus: askFeedback.triageStatus,
				updatedAt: askFeedback.updatedAt,
			});

		if (!updated) {
			throw new AskFeedbackNotFoundError("feedback record not found");
		}

		return {
			id: updated.id,
			triage_status: updated.triageStatus as AskFeedbackTriageStatus,
			updated_at: updated.updatedAt.toISOString(),
		};
	}
}
