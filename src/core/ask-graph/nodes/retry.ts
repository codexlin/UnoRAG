import {
	type AskState,
	type AskStateUpdate,
	mergeRetrievalDebug,
	requireQuestion,
} from "../state";

export const MAX_RETRIEVAL_ATTEMPTS = 2;

function compactRetryQuery(question: string, reason: string): string {
	const cleaned = question
		.replace(
			/^(?:请?结合(?:上述)?资料[，,]?\s*|请问[，,]?\s*|根据(?:所提供)?(?:文档|资料)(?:内容)?[，,]?\s*)/u,
			"",
		)
		.replace(
			/(?:分别是多少|是什么|有哪些|如何应对|怎么应对|有哪些主要差异|有何区别|请说明|请分析|并说明原因|[？?。，,；;]+)$/gu,
			"",
		)
		.replace(/\s+/gu, " ")
		.trim();
	if (cleaned.length >= 4 && cleaned !== question.trim()) {
		return cleaned;
	}
	const suffix = reason === "weak_match" ? "相关制度 条款 规定" : "关键词 概要";
	return `${question} ${suffix}`;
}

export function retryNode(state: AskState): AskStateUpdate {
	const base = state.rewritten_question || requireQuestion(state);
	const reason = String(state.judgement?.reason ?? "no_hit");
	const broadened = compactRetryQuery(base, reason);
	return {
		rewritten_question: broadened,
		...(state.upgrade_reason === "grounded_table_lookup"
			? { upgrade_reason: null }
			: {}),
		retrieval_debug: mergeRetrievalDebug(state, {
			retry: { from: base, to: broadened, reason },
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
