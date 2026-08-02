import { type AskGraphContext, defaultRefuseAnswer } from "../context";
import {
	type AskState,
	type AskStateUpdate,
	mergeRetrievalDebug,
} from "../state";

export function createRefuseNode(context: AskGraphContext) {
	return (state: AskState): AskStateUpdate => {
		const reason = String(
			state.judgement?.reason ?? state.refuse_reason ?? "invalid_graph_state",
		);
		const answer = (context.refuseAnswer ?? defaultRefuseAnswer)(state, reason);
		return {
			answer,
			citations: [],
			refused: true,
			refuse_reason: reason,
			retrieval_debug: mergeRetrievalDebug(state, {
				generate: "refuse",
				refuse_reason: reason,
				retrieved_candidate_count: state.citations?.length ?? 0,
			}),
		};
	};
}
