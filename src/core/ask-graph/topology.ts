import { END, START, StateGraph } from "@langchain/langgraph";
import type { AskGraphContext, AskNodePort } from "./context";
import { createDecisionNode, routeAfterJudge } from "./nodes/decision";
import { createRefuseNode } from "./nodes/refuse";
import { retryNode, routeAfterRetry } from "./nodes/retry";
import { createRewriteNode } from "./nodes/rewrite";
import {
	createRoutingNodes,
	routeAfterPlan,
	routeAfterRewrite,
} from "./nodes/routing";
import {
	type AskState,
	AskStateAnnotation,
	type AskStateUpdate,
	appendAskStage,
} from "./state";

export const ASK_GRAPH_NODE_NAMES = [
	"query_router",
	"build_retrieval_plan",
	"clarify",
	"build_table_plan",
	"table_retrieve",
	"table_execute",
	"rewrite",
	"retrieve",
	"judge",
	"retry",
	"generate",
	"refuse",
] as const;

export type AskGraphNodeName = (typeof ASK_GRAPH_NODE_NAMES)[number];

function routeAfterRetrieve(state: AskState): "upgrade_precise" | "judge" {
	return state.upgrade === "precise" ? "upgrade_precise" : "judge";
}

function routeAfterTableExecute(state: AskState): "judge" | "end" {
	const action = state.judgement?.action;
	if (action === "clarify" || state.refuse_reason === "table_incomplete") {
		return "end";
	}
	return "judge";
}

function timedNode(
	name: string,
	node: AskNodePort,
): (state: AskState) => Promise<AskStateUpdate> {
	return async (state) => {
		const startedAt = performance.now();
		try {
			const update = await node(state);
			return {
				...update,
				retrieval_debug: appendAskStage(
					update.retrieval_debug ?? state.retrieval_debug,
					name,
					startedAt,
					true,
				),
			};
		} catch (error) {
			state.retrieval_debug = appendAskStage(
				state.retrieval_debug,
				name,
				startedAt,
				false,
			);
			throw error;
		}
	};
}

export function compileAskGraph(context: AskGraphContext) {
	const routing = createRoutingNodes(context);
	const graph = new StateGraph(AskStateAnnotation)
		.addNode("query_router", timedNode("route", routing.queryRouter))
		.addNode("build_retrieval_plan", timedNode("plan", routing.buildPlan))
		.addNode("clarify", timedNode("clarify", routing.clarify))
		.addNode(
			"build_table_plan",
			timedNode("table_plan", context.ports.buildTablePlan),
		)
		.addNode(
			"table_retrieve",
			timedNode("table_retrieve", context.ports.tableRetrieve),
		)
		.addNode(
			"table_execute",
			timedNode("table_execute", context.ports.tableExecute),
		)
		.addNode("rewrite", timedNode("rewrite", createRewriteNode(context)))
		.addNode("retrieve", timedNode("retrieve", context.ports.retrieve))
		.addNode("judge", timedNode("judge", createDecisionNode(context)))
		.addNode("retry", timedNode("retry", retryNode))
		.addNode("generate", timedNode("prepare_generate", context.ports.generate))
		.addNode("refuse", timedNode("refuse", createRefuseNode(context)))
		.addEdge(START, "query_router")
		.addEdge("query_router", "build_retrieval_plan")
		.addConditionalEdges("build_retrieval_plan", routeAfterPlan, {
			clarify: "clarify",
			rewrite: "rewrite",
			refuse: "refuse",
		})
		.addEdge("clarify", END)
		.addEdge("table_retrieve", "build_table_plan")
		.addEdge("build_table_plan", "table_execute")
		.addConditionalEdges("table_execute", routeAfterTableExecute, {
			judge: "judge",
			end: END,
		})
		.addConditionalEdges("rewrite", routeAfterRewrite, {
			retrieve: "retrieve",
			table: "table_retrieve",
			refuse: "refuse",
		})
		.addConditionalEdges("retrieve", routeAfterRetrieve, {
			upgrade_precise: "table_retrieve",
			judge: "judge",
		})
		.addConditionalEdges("judge", routeAfterJudge, {
			retry: "retry",
			generate: "generate",
			refuse: "refuse",
		})
		.addConditionalEdges("retry", routeAfterRetry, {
			retrieve: "retrieve",
			table_retrieve: "table_retrieve",
			refuse: "refuse",
		})
		.addEdge("generate", END)
		.addEdge("refuse", END);

	return graph.compile();
}
