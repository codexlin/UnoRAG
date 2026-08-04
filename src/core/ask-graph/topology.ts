import { END, START, StateGraph } from "@langchain/langgraph";
import {
	setActiveSpanAttributes,
	withActiveSpan,
} from "@/lib/observability/tracing";
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
	stageName: string,
	node: AskNodePort,
	graphNodeName: AskGraphNodeName,
): (state: AskState) => Promise<AskStateUpdate> {
	return async (state) => {
		return withActiveSpan(
			`unorag.ask.node.${graphNodeName}`,
			{
				"langfuse.observation.type":
					graphNodeName === "retrieve" || graphNodeName === "table_retrieve"
						? "retriever"
						: "chain",
				"langfuse.observation.metadata.ask_node": graphNodeName,
				...(state.session_id
					? { "langfuse.session.id": state.session_id }
					: {}),
			},
			async () => {
				const startedAt = performance.now();
				try {
					const update = await node(state);
					setActiveSpanAttributes({
						...(typeof update.query_type === "string"
							? {
									"langfuse.observation.metadata.query_type": update.query_type,
								}
							: {}),
						...(Array.isArray(update.citations)
							? {
									"langfuse.observation.metadata.citation_count":
										update.citations.length,
								}
							: {}),
					});
					return {
						...update,
						retrieval_debug: appendAskStage(
							update.retrieval_debug ?? state.retrieval_debug,
							stageName,
							startedAt,
							true,
						),
					};
				} catch (error) {
					state.retrieval_debug = appendAskStage(
						state.retrieval_debug,
						stageName,
						startedAt,
						false,
					);
					throw error;
				}
			},
		);
	};
}

export function compileAskGraph(context: AskGraphContext) {
	const routing = createRoutingNodes(context);
	const graph = new StateGraph(AskStateAnnotation)
		.addNode(
			"query_router",
			timedNode("route", routing.queryRouter, "query_router"),
		)
		.addNode(
			"build_retrieval_plan",
			timedNode("plan", routing.buildPlan, "build_retrieval_plan"),
		)
		.addNode("clarify", timedNode("clarify", routing.clarify, "clarify"))
		.addNode(
			"build_table_plan",
			timedNode("table_plan", context.ports.buildTablePlan, "build_table_plan"),
		)
		.addNode(
			"table_retrieve",
			timedNode(
				"table_retrieve",
				context.ports.tableRetrieve,
				"table_retrieve",
			),
		)
		.addNode(
			"table_execute",
			timedNode("table_execute", context.ports.tableExecute, "table_execute"),
		)
		.addNode(
			"rewrite",
			timedNode("rewrite", createRewriteNode(context), "rewrite"),
		)
		.addNode(
			"retrieve",
			timedNode("retrieve", context.ports.retrieve, "retrieve"),
		)
		.addNode("judge", timedNode("judge", createDecisionNode(context), "judge"))
		.addNode("retry", timedNode("retry", retryNode, "retry"))
		.addNode(
			"generate",
			timedNode("prepare_generate", context.ports.generate, "generate"),
		)
		.addNode("refuse", timedNode("refuse", createRefuseNode(context), "refuse"))
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
