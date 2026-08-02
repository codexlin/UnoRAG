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
		record_type: "chunk+table_summary",
	};
}

export function createRoutingNodes(context: AskGraphContext) {
	return {
		queryRouter: async (state: AskState): Promise<AskStateUpdate> => {
			const routed = await context.queryRouter.route({
				question: requireQuestion(state),
				history: state.history ?? [],
				libraryId: state.library_id ?? null,
			});
			const rawQueryType = routed.queryType?.trim() || "";
			const queryType = KNOWN_QUERY_TYPES.has(rawQueryType)
				? rawQueryType
				: "ambiguous";
			const reason =
				queryType === rawQueryType
					? routed.reason?.trim() || "unspecified_route"
					: "invalid_router_result";
			return {
				query_type: queryType,
				route_reason: reason,
				retrieval_attempts: 0,
				refused: false,
				refuse_reason: null,
				retrieval_plan: routed.plan,
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
