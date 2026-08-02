import type {
	AskHistoryMessage,
	AskMetadata,
	AskState,
	AskStateUpdate,
} from "./state";

export type Awaitable<T> = T | Promise<T>;
export type AskNodePort = (state: AskState) => Awaitable<AskStateUpdate>;

export interface QueryRoute {
	queryType: string;
	reason: string;
	plan?: AskMetadata;
}

export interface QueryRouter {
	route(input: {
		question: string;
		history: AskHistoryMessage[];
		libraryId: string | null;
	}): Awaitable<QueryRoute>;
}

export interface QueryRewrite {
	query: string;
	mode?: string;
	plan?: AskMetadata;
}

export interface QueryRewriter {
	rewrite(input: {
		question: string;
		history: AskHistoryMessage[];
		plan: AskMetadata;
	}): Awaitable<QueryRewrite>;
}

export interface Judgement {
	sufficient: boolean;
	action: "retry" | "generate" | "refuse" | string;
	reason: string;
	can_retry?: boolean;
	[key: string]: unknown;
}

export interface Judge {
	judge(state: AskState): Awaitable<Judgement>;
}

export interface AskGraphPorts {
	retrieve: AskNodePort;
	buildTablePlan: AskNodePort;
	tableRetrieve: AskNodePort;
	tableExecute: AskNodePort;
	generate: AskNodePort;
}

export interface AskGraphContext {
	queryRouter: QueryRouter;
	queryRewriter: QueryRewriter;
	judge: Judge;
	ports: AskGraphPorts;
	clarifyAnswer?: (state: AskState) => string;
	refuseAnswer?: (state: AskState, reason: string) => string;
}

export function defaultClarifyAnswer(_state: AskState): string {
	return "请补充你想在当前知识库中查询的主题、对象或时间范围。";
}

export function defaultRefuseAnswer(_state: AskState, reason: string): string {
	if (reason === "weak_match") {
		return "当前知识库中存在相关内容，但证据不足以可靠回答。";
	}
	return "当前知识库中没有找到足以支持回答的内容。";
}
