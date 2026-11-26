import { type AskGraphContext, defaultClarifyAnswer } from "../context";
import {
	type AskMetadata,
	type AskState,
	type AskStateUpdate,
	mergeRetrievalDebug,
	requireQuestion,
} from "../state";
import {
	isDerivedCalculationQuestion,
	isFormFieldLookup,
	isProseChecklistLookup,
} from "../table/query-intent";
import { hasFollowupReference } from "./rewrite";
import {
	isCompareQuestion,
	isExplicitTableStructureQuestion,
	isFigureProseQuestion,
	isSummaryProseReference,
	PROSE_SUPERLATIVE_COMPARE_PATTERN,
} from "./thin-router";

const KNOWN_PATHS = new Set(["fast", "precise", "clarify"]);
const KNOWN_EXECUTE_PATHS = new Set(["short", "table", "clarify"]);
const KNOWN_QUERY_TYPES = new Set([
	"fact",
	"summary",
	"table",
	"compare",
	"follow_up",
	"section_lookup",
	"ambiguous",
]);
// Legacy compatibility guard for injected table routes that name multiple paired table fields.
const PAIRED_FIELD_TABLE_CUE_PATTERN =
	/(?:单价|合计金额?|规格参数|品牌\s*\/\s*型号|采购单位|中标供应商).{0,40}(?:单价|合计金额?|规格参数|品牌\s*\/\s*型号|采购单位|中标供应商)/iu;
const SELF_CONTAINED_RETRIEVAL_PATTERN =
	/(?:根据|依据|关于|针对|规定|要求|提到|说明|显示|列出|包括|\b(?:according\s+to|based\s+on|under|regarding|about|specif(?:y|ies|ied)|requir(?:e|es|ed)|mention(?:s|ed)?|list(?:s|ed)?|includ(?:e|es|ed))\b)/iu;

function hasExplicitTableCue(question: string): boolean {
	return (
		isExplicitTableStructureQuestion(question) ||
		PAIRED_FIELD_TABLE_CUE_PATTERN.test(question)
	);
}

function hasSelfContainedRetrievalScope(question: string): boolean {
	const trimmed = question.trim();
	return (
		Array.from(trimmed).length >= 10 &&
		!hasFollowupReference(trimmed) &&
		SELF_CONTAINED_RETRIEVAL_PATTERN.test(trimmed)
	);
}

function executionQueryType(rawQueryType: string, question: string): string {
	if (
		rawQueryType === "table" &&
		(isFormFieldLookup(question) ||
			isProseChecklistLookup(question) ||
			isDerivedCalculationQuestion(question))
	)
		return "fact";
	if (
		rawQueryType === "ambiguous" &&
		hasSelfContainedRetrievalScope(question)
	) {
		return "fact";
	}
	if (
		["fact", "section_lookup"].includes(rawQueryType) &&
		isCompareQuestion(question) &&
		!isFigureProseQuestion(question) &&
		!hasExplicitTableCue(question) &&
		!isDerivedCalculationQuestion(question)
	) {
		return "compare";
	}
	if (
		rawQueryType === "table" &&
		(isSummaryProseReference(question) ||
			isFigureProseQuestion(question) ||
			!hasExplicitTableCue(question))
	) {
		return "fact";
	}
	return rawQueryType === "compare" &&
		hasExplicitTableCue(question) &&
		!isDerivedCalculationQuestion(question)
		? "table"
		: rawQueryType;
}

function factOverrideReason(question: string, fallback: string): string {
	if (isSummaryProseReference(question)) {
		return `summary_prose_cue: ${fallback}`;
	}
	if (isFigureProseQuestion(question)) {
		return `figure_prose_cue: ${fallback}`;
	}
	if (isDerivedCalculationQuestion(question)) {
		return `derived_calculation_cue: ${fallback}`;
	}
	if (hasSelfContainedRetrievalScope(question)) {
		return `self_contained_retrieval_cue: ${fallback}`;
	}
	return `prose_retrieval_cue: ${fallback}`;
}

function routeOverrideReason(
	queryType: string,
	question: string,
	fallback: string,
): string {
	if (
		queryType === "compare" &&
		PROSE_SUPERLATIVE_COMPARE_PATTERN.test(question)
	) {
		return `prose_superlative_cue: ${fallback}`;
	}
	if (queryType === "compare") {
		return `prose_compare_cue: ${fallback}`;
	}
	if (queryType === "fact") return factOverrideReason(question, fallback);
	return `table_execution_cue: ${fallback}`;
}

function defaultPlan(queryType: string, reason: string): AskMetadata {
	if (queryType === "ambiguous") {
		return {
			query_type: queryType,
			reason,
			route: "clarify",
			path: "clarify",
			execute_path: "clarify",
		};
	}
	if (queryType === "table") {
		return {
			query_type: queryType,
			reason,
			route: "table",
			path: "precise",
			precise_kind: "table",
			execute_path: "table",
			record_type: "table",
		};
	}
	return {
		query_type: queryType,
		reason,
		route: "short",
		path: "fast",
		execute_path: "short",
		filters: { record_type: "text" },
	};
}

export function planForGroundedQuestion(
	rawQueryType: string,
	question: string,
	reason: string,
): AskMetadata {
	const normalized = executionQueryType(rawQueryType, question);
	const queryType = KNOWN_QUERY_TYPES.has(normalized)
		? normalized
		: "ambiguous";
	const plan = defaultPlan(queryType, reason);
	return queryType === "table"
		? { ...plan, filters: { record_type: "table" } }
		: plan;
}

export function createRoutingNodes(context: AskGraphContext) {
	return {
		queryRouter: async (state: AskState): Promise<AskStateUpdate> => {
			const question = requireQuestion(state);
			const routed = await context.queryRouter.route({
				question,
				history: state.history ?? [],
				libraryId: state.library_id ?? null,
			});
			const rawQueryType = routed.queryType?.trim() || "";
			const normalizedQueryType = executionQueryType(rawQueryType, question);
			const queryType = KNOWN_QUERY_TYPES.has(normalizedQueryType)
				? normalizedQueryType
				: "ambiguous";
			const reason = !KNOWN_QUERY_TYPES.has(normalizedQueryType)
				? "invalid_router_result"
				: queryType !== rawQueryType
					? routeOverrideReason(
							queryType,
							question,
							routed.reason?.trim() || rawQueryType || "router",
						)
					: routed.reason?.trim() || "unspecified_route";
			const routedPlan = { ...(routed.plan ?? {}) };
			return {
				query_type: queryType,
				route_reason: reason,
				retrieval_attempts: 0,
				refused: false,
				refuse_reason: null,
				retrieval_plan: routedPlan,
				retrieval_debug: mergeRetrievalDebug(state, {
					query_type: queryType,
					route_reason: reason,
					...(routed.layer ? { route_layer: routed.layer } : {}),
				}),
			};
		},

		buildPlan: (state: AskState): AskStateUpdate => {
			const queryType = state.query_type || "ambiguous";
			const routeReason = state.route_reason || "invalid_router_result";
			const plan = {
				...defaultPlan(queryType, routeReason),
				...(state.retrieval_plan ?? {}),
			};
			return {
				retrieval_plan: plan,
				upgrade: null,
				upgrade_reason: null,
				downgrade_reason: null,
				retrieval_debug: mergeRetrievalDebug(state, {
					retrieval_plan: plan,
					route: plan.route,
					path: plan.path,
					precise_kind: plan.precise_kind,
				}),
			};
		},

		clarify: (state: AskState): AskStateUpdate => {
			const judgement = {
				sufficient: false,
				action: "clarify",
				reason: "ambiguous",
				can_retry: false,
			};
			return {
				answer:
					state.answer ||
					(context.clarifyAnswer ?? defaultClarifyAnswer)(state),
				citations: [],
				refused: true,
				refuse_reason: "ambiguous",
				judgement,
				retrieval_debug: mergeRetrievalDebug(state, {
					judgement,
					generate: "clarify",
					refuse_reason: "ambiguous",
				}),
			};
		},
	};
}

export type RouteAfterPlan = "clarify" | "rewrite" | "refuse";

export function routeAfterPlan(state: AskState): RouteAfterPlan {
	const plan = state.retrieval_plan ?? {};
	const path = String(plan.path ?? "");
	const executePath = String(plan.execute_path ?? "");
	if (path === "clarify" || executePath === "clarify") {
		return "clarify";
	}
	if (!KNOWN_PATHS.has(path) || !KNOWN_EXECUTE_PATHS.has(executePath)) {
		return "refuse";
	}
	return "rewrite";
}

export type RouteAfterRewrite = "retrieve" | "table" | "refuse" | "clarify";

export function routeAfterRewrite(state: AskState): RouteAfterRewrite {
	const plan = state.retrieval_plan ?? {};
	const path = String(plan.path ?? "");
	const executePath = String(plan.execute_path ?? "");
	if (path === "clarify" && executePath === "clarify") return "clarify";
	if (
		(path === "precise" && plan.precise_kind === "table") ||
		executePath === "table"
	) {
		return "table";
	}
	if ((path === "fast" || path === "precise") && executePath === "short") {
		return "retrieve";
	}
	return "refuse";
}
