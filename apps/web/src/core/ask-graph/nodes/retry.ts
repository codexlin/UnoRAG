import {
	type AskState,
	type AskStateUpdate,
	mergeRetrievalDebug,
	requireQuestion,
} from "../state";

export function retryNode(state: AskState): AskStateUpdate {
	const base = state.rewritten_question || requireQuestion(state);
	const reason = String(state.judgement?.reason ?? "no_hit");
	const suffix = reason === "weak_match" ? "相关制度 条款 规定" : "关键词 概要";
	const broadened = `${base} ${suffix}`;
	return {
		rewritten_question: broadened,
		retrieval_debug: mergeRetrievalDebug(state, {
			retry: { from: base, to: broadened, reason },
		}),
	};
}

export type RouteAfterRetry = "retrieve" | "table_retrieve" | "refuse";

export function routeAfterRetry(state: AskState): RouteAfterRetry {
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
