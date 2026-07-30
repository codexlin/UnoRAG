import type { AskGraphContext } from "../context";
import {
	type AskState,
	type AskStateUpdate,
	mergeRetrievalDebug,
	requireQuestion,
} from "../state";

export function createRewriteNode(context: AskGraphContext) {
	return async (state: AskState): Promise<AskStateUpdate> => {
		const rewritten = await context.queryRewriter.rewrite({
			question: requireQuestion(state),
			history: state.history ?? [],
			plan: state.retrieval_plan ?? {},
		});
		const query = rewritten.query?.trim();
		if (!query) {
			return {
				refuse_reason: "invalid_rewrite",
				retrieval_plan: {
					...(state.retrieval_plan ?? {}),
					path: "invalid",
					execute_path: "invalid",
				},
				retrieval_debug: mergeRetrievalDebug(state, {
					rewrite: "invalid",
				}),
			};
		}
		const plan = {
			...(state.retrieval_plan ?? {}),
			...(rewritten.plan ?? {}),
			rewritten_queries: [query],
		};
		return {
			rewritten_question: query,
			retrieval_plan: plan,
			retrieval_attempts: 0,
			refused: false,
			refuse_reason: null,
			retrieval_debug: mergeRetrievalDebug(state, {
				rewrite: rewritten.mode ?? "injected",
				history_turns: state.history?.length ?? 0,
				retrieval_plan: plan,
				retrieval_query: query,
			}),
		};
	};
}
