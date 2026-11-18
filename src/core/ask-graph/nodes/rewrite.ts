import type { AskGraphContext } from "../context";
import {
	type AskMetadata,
	type AskState,
	type AskStateUpdate,
	mergeRetrievalDebug,
	requireQuestion,
} from "../state";

const FOLLOWUP_REFERENCE_ZH_RE =
	/(?:^|[\s，,。！？(（])(?:它|它们|他|他们|她|她们|这|这个|这些|这里|这种|这样|那|那个|那些|那里|那种|那样|上述|上面|前面|刚才|上文|之前|该|此|继续|展开|详细说说|再说说|为什么呢|怎么解决|如何处理|还有吗|有哪些补充)/;
const FOLLOWUP_REFERENCE_EN_RE =
	/\b(?:it|its|they|them|their|this|that|these|those|above|previous|former|latter|same|elaborate|more details?|continue|follow[\s-]?up)\b/i;

const EMBEDDED_REFERENCE_ZH_RE =
	/(?<!其)(?:它|他(?:们|的))|她(?:们|的)|上述|前者|后者|刚才|(?<!应)该(?:方案|文件|合同|规定)|这(?:个|份|项)|那(?:个|份|项)/;

export function hasFollowupReference(question: string): boolean {
	return (
		EMBEDDED_REFERENCE_ZH_RE.test(question) ||
		FOLLOWUP_REFERENCE_ZH_RE.test(question) ||
		FOLLOWUP_REFERENCE_EN_RE.test(question)
	);
}

/**
 * Returns true when a follow-up question appears self-contained (sufficiently
 * specific and free of common references); this fast path is a heuristic.
 */
export function isSelfContainedFollowupQuestion(question: string): boolean {
	const trimmed = question.trim();
	if (trimmed.length < 8 || hasFollowupReference(trimmed)) return false;
	// Length alone cannot distinguish “生效日期是什么时候？” from a named lookup.
	// With history, prefer one resolution call over silently dropping an omitted subject.
	return /《[^》]+》|(?:根据|依据|关于|针对)\S{2}|[\p{L}\d][\p{L}\d\s-]{1,40}(?:的|中|里)\S{2}|\b(?:for|of|about|under|within)\s+\w{2,}/iu.test(
		trimmed,
	);
}

export function createRewriteNode(context: AskGraphContext) {
	return async (state: AskState): Promise<AskStateUpdate> => {
		const rewritten = await context.queryRewriter.rewrite({
			question: requireQuestion(state),
			history: state.history ?? [],
			plan: state.retrieval_plan ?? {},
		});
		const query = rewritten.query?.trim();
		if (rewritten.clarification) {
			const plan = {
				...state.retrieval_plan,
				route: "clarify",
				path: "clarify",
				execute_path: "clarify",
			};
			return {
				answer: rewritten.clarification,
				retrieval_plan: plan,
				retrieval_debug: mergeRetrievalDebug(state, {
					rewrite: rewritten.mode,
					pending_clarification: rewritten.pendingClarification,
					retrieval_plan: plan,
					route: "clarify",
					path: "clarify",
				}),
			};
		}
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
		const plan: AskMetadata = {
			...currentPlan,
			...rewrittenPlan,
			filters: { ...currentFilters, ...rewrittenFilters },
			rewritten_queries: [query],
		};
		return {
			query_type:
				typeof plan.query_type === "string"
					? plan.query_type
					: state.query_type,
			rewritten_question: query,
			retrieval_plan: plan,
			retrieval_attempts: 0,
			refused: false,
			refuse_reason: null,
			retrieval_debug: mergeRetrievalDebug(state, {
				query_type: plan.query_type ?? state.query_type,
				route: plan.route,
				path: plan.path,
				precise_kind: plan.precise_kind,
				rewrite: rewritten.mode ?? "injected",
				history_turns: state.history?.length ?? 0,
				retrieval_plan: plan,
				retrieval_query: query,
			}),
		};
	};
}
