import { type AskGraphContext, defaultClarifyAnswer } from "../context";
import {
	type AskMetadata,
	type AskState,
	type AskStateUpdate,
	mergeRetrievalDebug,
	requireQuestion,
} from "../state";

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
const EXPLICIT_TABLE_COMPARE_PATTERN =
	/(?:表格|表中|表内|明细表|清单|台账|逐行|多少行|设备条目|表头|列名|字段|序号\s*(?:为|是)?\s*\d+|rows?|row\s*#?\s*\d+|(?:单价|合计金额?|规格参数|品牌\s*\/\s*型号|采购单位|中标供应商).{0,40}(?:单价|合计金额?|规格参数|品牌\s*\/\s*型号|采购单位|中标供应商))/i;
const SUMMARY_PROSE_PATTERN = /(?:文末)?汇总说明(?:中|里|声称|称|显示|指出)?/i;
const IGNORE_SUMMARY_PROSE_PATTERN =
	/(?:忽略|不看|排除|不要参考)[^，。；;]{0,16}(?:文末)?汇总说明/i;
const FIGURE_PROSE_PATTERN =
	/(?:图\s*\d+|图表|折线图|柱状图|堆叠图|饼图|趋势图)/i;
const PROSE_SUPERLATIVE_COMPARE_PATTERN =
	/(?:最高|最低|最大|最小|最多|最少)[^，。？?]{0,16}(?:哪一|哪个|何种|什么)|(?:哪一|哪个|何种|什么)[^，。？?]{0,16}(?:最高|最低|最大|最小|最多|最少)/i;
const SELF_CONTAINED_RETRIEVAL_PATTERN =
	/(?:根据|依据|关于|针对|规定|要求|提到|说明|显示|列出|包括|中|里)/i;

function hasSelfContainedRetrievalScope(question: string): boolean {
	return (
		Array.from(question.trim()).length >= 10 &&
		SELF_CONTAINED_RETRIEVAL_PATTERN.test(question)
	);
}

function executionQueryType(rawQueryType: string, question: string): string {
	if (
		rawQueryType === "ambiguous" &&
		hasSelfContainedRetrievalScope(question)
	) {
		return "fact";
	}
	if (
		["fact", "section_lookup"].includes(rawQueryType) &&
		PROSE_SUPERLATIVE_COMPARE_PATTERN.test(question) &&
		!FIGURE_PROSE_PATTERN.test(question) &&
		!EXPLICIT_TABLE_COMPARE_PATTERN.test(question)
	) {
		return "compare";
	}
	if (
		rawQueryType === "table" &&
		((SUMMARY_PROSE_PATTERN.test(question) &&
			!IGNORE_SUMMARY_PROSE_PATTERN.test(question)) ||
			FIGURE_PROSE_PATTERN.test(question) ||
			!EXPLICIT_TABLE_COMPARE_PATTERN.test(question))
	) {
		return "fact";
	}
	return rawQueryType === "compare" &&
		EXPLICIT_TABLE_COMPARE_PATTERN.test(question)
		? "table"
		: rawQueryType;
}

function factOverrideReason(question: string, fallback: string): string {
	if (
		SUMMARY_PROSE_PATTERN.test(question) &&
		!IGNORE_SUMMARY_PROSE_PATTERN.test(question)
	) {
		return `summary_prose_cue: ${fallback}`;
	}
	if (FIGURE_PROSE_PATTERN.test(question)) {
		return `figure_prose_cue: ${fallback}`;
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
				answer: (context.clarifyAnswer ?? defaultClarifyAnswer)(state),
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

export type RouteAfterRewrite = "retrieve" | "table" | "refuse";

export function routeAfterRewrite(state: AskState): RouteAfterRewrite {
	const plan = state.retrieval_plan ?? {};
	const path = String(plan.path ?? "");
	const executePath = String(plan.execute_path ?? "");
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
