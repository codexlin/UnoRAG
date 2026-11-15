import type { AskGraphContext } from "../context";
import {
	type AskState,
	type AskStateUpdate,
	mergeRetrievalDebug,
	requireQuestion,
} from "../state";

const FOLLOWUP_REFERENCE_ZH_RE =
	/(?:^|[\s，,。！？(（])(?:它|它们|他|他们|她|她们|这|这个|这些|这里|这种|这样|那|那个|那些|那里|那种|那样|上述|上面|前面|刚才|上文|之前|该|此|继续|展开|详细说说|再说说|为什么呢|怎么解决|如何处理|还有吗|有哪些补充)/;
const FOLLOWUP_REFERENCE_EN_RE =
	/\b(?:it|its|they|them|their|this|that|these|those|above|previous|former|latter|same|elaborate|more details?|continue|follow[\s-]?up)\b/i;

/**
 * Returns true when a follow-up question appears self-contained (sufficiently
 * specific and free of anaphoric or elliptical references), allowing Ask to
 * skip the extra LLM rewrite round-trip without losing coreference accuracy.
 */
export function isSelfContainedFollowupQuestion(question: string): boolean {
	const trimmed = question.trim();
	if (trimmed.length < 8) return false;
	if (FOLLOWUP_REFERENCE_ZH_RE.test(trimmed)) return false;
	if (FOLLOWUP_REFERENCE_EN_RE.test(trimmed)) return false;
	return true;
}

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
		const currentPlan = state.retrieval_plan ?? {};
		const rewrittenPlan = rewritten.plan ?? {};
		const currentFilters =
			currentPlan.filters &&
			typeof currentPlan.filters === "object" &&
			!Array.isArray(currentPlan.filters)
				? (currentPlan.filters as Record<string, unknown>)
				: {};
		const rewrittenFilters =
			rewrittenPlan.filters &&
			typeof rewrittenPlan.filters === "object" &&
			!Array.isArray(rewrittenPlan.filters)
				? (rewrittenPlan.filters as Record<string, unknown>)
				: {};
		const plan = {
			...currentPlan,
			...rewrittenPlan,
			filters: { ...currentFilters, ...rewrittenFilters },
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
