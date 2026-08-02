import { Annotation } from "@langchain/langgraph";

export type AskMetadata = Record<string, unknown>;
export type AskHistoryMessage = Record<string, unknown>;
export type Citation = Record<string, unknown>;

export const ASK_STATE_FIELD_NAMES = [
	"session_id",
	"question",
	"library_id",
	"history",
	"rewritten_question",
	"citations",
	"answer",
	"refused",
	"refuse_reason",
	"retrieval_attempts",
	"judgement",
	"retrieval_debug",
	"trace_id",
	"query_type",
	"route_reason",
	"retrieval_plan",
	"table_query_plan",
	"table_execution",
	"upgrade",
	"upgrade_reason",
	"downgrade_reason",
] as const;

export const AskStateAnnotation = Annotation.Root({
	session_id: Annotation<string | undefined>(),
	question: Annotation<string | undefined>(),
	library_id: Annotation<string | null | undefined>(),
	history: Annotation<AskHistoryMessage[] | undefined>(),
	rewritten_question: Annotation<string | undefined>(),
	citations: Annotation<Citation[] | undefined>(),
	answer: Annotation<string | undefined>(),
	refused: Annotation<boolean | undefined>(),
	refuse_reason: Annotation<string | null | undefined>(),
	retrieval_attempts: Annotation<number | undefined>(),
	judgement: Annotation<AskMetadata | undefined>(),
	retrieval_debug: Annotation<AskMetadata | undefined>(),
	trace_id: Annotation<string | undefined>(),
	query_type: Annotation<string | undefined>(),
	route_reason: Annotation<string | undefined>(),
	retrieval_plan: Annotation<AskMetadata | undefined>(),
	table_query_plan: Annotation<AskMetadata | undefined>(),
	table_execution: Annotation<AskMetadata | undefined>(),
	upgrade: Annotation<string | null | undefined>(),
	upgrade_reason: Annotation<string | null | undefined>(),
	downgrade_reason: Annotation<string | null | undefined>(),
});

export type AskState = typeof AskStateAnnotation.State;
export type AskStateUpdate = typeof AskStateAnnotation.Update;
export type AskGraphInput = Partial<AskState> & { question: string };

export function mergeRetrievalDebug(
	state: AskState,
	extra: AskMetadata,
): AskMetadata {
	return {
		...(state.retrieval_debug ?? {}),
		...extra,
	};
}

export function requireQuestion(state: AskState): string {
	const question = state.question?.trim();
	if (!question) {
		throw new Error("AskGraph requires a non-empty question");
	}
	return question;
}
