import type { AskGraphContext, Judgement } from "../context";
import {
	type AskState,
	type AskStateUpdate,
	mergeRetrievalDebug,
} from "../state";

const KNOWN_ACTIONS = new Set(["retry", "generate", "refuse"]);

function failClosedJudgement(judgement: Judgement): Judgement {
	if (KNOWN_ACTIONS.has(judgement.action)) {
		return judgement;
	}
	return {
		sufficient: false,
		action: "refuse",
		reason: "invalid_judgement_action",
		can_retry: false,
	};
}

export function createDecisionNode(context: AskGraphContext) {
	return async (state: AskState): Promise<AskStateUpdate> => {
		const judgement = failClosedJudgement(await context.judge.judge(state));
		const judgeDebug = Object.fromEntries(
			[
				"judge_mode",
				"judge_model",
				"judge_provider",
				"judge_attempts",
				"judge_duration_ms",
				"judge_input_tokens",
				"judge_output_tokens",
				"judge_total_tokens",
			].flatMap((key) =>
				judgement[key] !== undefined ? [[key, judgement[key]]] : [],
			),
		);
		return {
			judgement,
			refuse_reason: judgement.action === "refuse" ? judgement.reason : null,
			retrieval_debug: mergeRetrievalDebug(state, {
				judgement,
				...judgeDebug,
			}),
		};
	};
}

export type RouteAfterJudge = "retry" | "generate" | "refuse";

export function routeAfterJudge(state: AskState): RouteAfterJudge {
	const action = state.judgement?.action;
	if (action === "retry") {
		return state.judgement?.can_retry !== false &&
			(state.retrieval_attempts ?? 0) < 2
			? "retry"
			: "refuse";
	}
	if (action === "generate") {
		return action;
	}
	return "refuse";
}
