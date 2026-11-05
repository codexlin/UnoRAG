import { QueryTypeSchema } from "../ai/structured-output";
import { projectRerankDiagnostic } from "../retrieval/provider-request";
import type { AskMetadata, AskStageTiming, AskState } from "./state";

const stages = new Set([
	"route",
	"plan",
	"clarify",
	"table_plan",
	"table_retrieve",
	"table_execute",
	"rewrite",
	"retrieve",
	"judge",
	"retry",
	"prepare_generate",
	"refuse",
]);

export type AskExecutionDiagnostics = {
	query_type: string | undefined;
	retrieval_debug: {
		stages: AskStageTiming[];
		retrievalMode?: "dense" | "hybrid";
	};
};

/** Keep failure timings across the graph boundary without retaining content. */
export class AskGraphExecutionError extends Error {
	readonly diagnostics: AskExecutionDiagnostics;

	constructor(cause: unknown, state: AskState, debug: AskMetadata) {
		super("Ask graph execution failed", { cause });
		this.name = "AskGraphExecutionError";
		const queryType = QueryTypeSchema.safeParse(state.query_type);
		const mode = debug.retrievalMode;
		this.diagnostics = {
			query_type: queryType.success ? queryType.data : undefined,
			retrieval_debug: {
				...(mode === "dense" || mode === "hybrid"
					? { retrievalMode: mode }
					: {}),
				stages: (Array.isArray(debug.stages) ? debug.stages : []).flatMap(
					(value) => {
						if (!value || typeof value !== "object") return [];
						const stage = value as Record<string, unknown>;
						if (
							typeof stage.stage !== "string" ||
							!stages.has(stage.stage) ||
							typeof stage.duration_ms !== "number" ||
							!Number.isFinite(stage.duration_ms) ||
							stage.duration_ms < 0 ||
							typeof stage.ok !== "boolean"
						)
							return [];
						const detail =
							stage.detail && typeof stage.detail === "object"
								? (stage.detail as Record<string, unknown>)
								: {};
						const rerank =
							stage.stage === "retrieve" || stage.stage === "table_retrieve"
								? projectRerankDiagnostic(detail.rerankDiagnostic)
								: null;
						return [
							{
								stage: stage.stage,
								duration_ms: stage.duration_ms,
								ok: stage.ok,
								...(rerank ? { detail: { rerankDiagnostic: rerank } } : {}),
							},
						];
					},
				),
			},
		};
	}
}
