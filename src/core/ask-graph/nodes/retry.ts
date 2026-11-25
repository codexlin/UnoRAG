import {
	type AskState,
	type AskStateUpdate,
	mergeRetrievalDebug,
	requireQuestion,
} from "../state";

export const MAX_RETRIEVAL_ATTEMPTS = 2;

export type RetryStrategy = "judge_missing_query" | "compact_fallback";

const MAX_MISSING_QUERY_LENGTH = 100;

export function sanitizeMissingQuery(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const cleaned = value
		.replace(/[\r\n\t]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	if (cleaned.length < 2 || cleaned.length > MAX_MISSING_QUERY_LENGTH) {
		return null;
	}
	return cleaned;
}

function compactRetryQuery(question: string, reason: string): string {
	const trimmed = question.trim();
	const cleaned = trimmed
		.replace(
			/^(?:请?结合(?:上述)?资料[，,]?\s*|请问[，,]?\s*|根据(?:所提供)?(?:文档|资料)(?:内容)?[，,]?\s*|(?:please\s+)?(?:explain|tell\s+me|describe|what\s+(?:is|are)|how\s+(?:do|does|can|to))\s+)/iu,
			"",
		)
		.replace(
			/(?:分别是多少|是什么|有哪些|如何应对|怎么应对|有哪些主要差异|有何区别|请说明|请分析|并说明原因|[？?。，,；;]+)$/gu,
			"",
		)
		.replace(/\s+/gu, " ")
		.trim();
	if (cleaned.length >= 4 && cleaned !== trimmed) {
		return cleaned;
	}
	const hasHan = /\p{Script=Han}/u.test(trimmed);
	if (hasHan) {
		const suffix =
			reason === "weak_match" ? "相关制度 条款 规定" : "关键词 概要";
		return `${trimmed} ${suffix}`;
	}
	const suffix =
		reason === "weak_match" ? "policy details" : "overview details";
	return `${trimmed} ${suffix}`;
}

export function retryNode(state: AskState): AskStateUpdate {
	const base = state.rewritten_question || requireQuestion(state);
	const reason = String(state.judgement?.reason ?? "no_hit");
	const targetedMissingQuery =
		state.judgement?.action === "retry"
			? sanitizeMissingQuery(state.judgement.missing_query)
			: null;
	const strategy: RetryStrategy = targetedMissingQuery
		? "judge_missing_query"
		: "compact_fallback";
	const nextQuery = targetedMissingQuery ?? compactRetryQuery(base, reason);
	return {
		rewritten_question: nextQuery,
		...(state.upgrade_reason === "grounded_table_lookup" ||
		state.upgrade_reason === "evidence_driven_table_operation"
			? { upgrade_reason: null }
			: {}),
		retrieval_debug: mergeRetrievalDebug(state, {
			retry_strategy: strategy,
			retry: { from: base, to: nextQuery, reason, strategy },
		}),
	};
}

export type RouteAfterRetry = "retrieve" | "table_retrieve" | "refuse";

export function routeAfterRetry(state: AskState): RouteAfterRetry {
	if ((state.retrieval_attempts ?? 0) >= MAX_RETRIEVAL_ATTEMPTS) {
		return "refuse";
	}
	const plan = state.retrieval_plan ?? {};
	if (
		state.query_type === "table" ||
		plan.path === "precise" ||
		state.upgrade === "precise"
	) {
		return "table_retrieve";
	}
	if (plan.path === "fast" && plan.execute_path === "short") {
		return "retrieve";
	}
	return "refuse";
}
