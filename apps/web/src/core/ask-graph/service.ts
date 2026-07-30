import type { AskGraphContext } from "./context";
import { type AskGraphInput, type AskState, requireQuestion } from "./state";
import { compileAskGraph } from "./topology";

export class AskGraphService {
	readonly graph;

	constructor(context: AskGraphContext) {
		this.graph = compileAskGraph(context);
	}

	async invoke(input: AskGraphInput): Promise<AskState> {
		requireQuestion(input as AskState);
		const result = await this.graph.invoke(input as AskState);
		return result;
	}
}
