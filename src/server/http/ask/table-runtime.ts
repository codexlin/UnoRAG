import "server-only";

import type { StructuredOutputAdapter } from "@/core/ai";
import type { AskGraphContext } from "@/core/ask-graph";
import {
	deriveDeterministicTablePlan,
	deriveGroundedTableLookup,
	executeTableQuery,
	normalizeTablePlanForQuestion,
	type TableDatasetInput,
	TableExecutionResultSchema,
	type TableQueryPlan,
	TableQueryPlanSchema,
} from "@/core/ask-graph/table";
import type { InternalCitation } from "@/core/retrieval";

export function deterministicTableAnswer(value: unknown): string | null {
	const parsed = TableExecutionResultSchema.safeParse(value);
	if (parsed.success && parsed.data.status === "success") {
		const answer = parsed.data.answerText?.trim();
		return answer || null;
	}
	return null;
}

export function tableCandidates(citations: InternalCitation[]) {
	const grouped = new Map<string, InternalCitation[]>();
	for (const citation of citations) {
		if (citation.record_type !== "table" || !citation.table_id) continue;
		const key = `${citation.doc_id}:${citation.document_version_id}:${citation.table_id}`;
		const current = grouped.get(key) ?? [];
		current.push(citation);
		grouped.set(key, current);
	}
	return [...grouped.entries()].map(([tableId, records]) => ({
		tableId: records[0]?.table_id ?? tableId,
		headers: [...new Set(records.flatMap((record) => record.headers))],
		dataset: { records } satisfies TableDatasetInput,
	}));
}

function selectTableCandidate(
	candidates: ReturnType<typeof tableCandidates>,
	tableId: string,
) {
	const matches = candidates.filter(
		(candidate) => candidate.tableId === tableId,
	);
	return matches.length === 1 ? matches[0] : null;
}

export function executePlannedTableQuery(
	plan: TableQueryPlan,
	citations: InternalCitation[],
) {
	const candidates = tableCandidates(citations);
	if (plan.mode === "single") {
		const candidate = selectTableCandidate(candidates, plan.tableId);
		return candidate ? executeTableQuery(plan, candidate.dataset) : null;
	}
	const left = selectTableCandidate(candidates, plan.leftTableId);
	const right = selectTableCandidate(candidates, plan.rightTableId);
	return left && right
		? executeTableQuery(plan, {
				left: left.dataset,
				right: right.dataset,
			})
		: null;
}

function selectEvidenceCitations(
	citations: InternalCitation[],
	evidenceIds: string[],
): InternalCitation[] {
	const selected = new Set(evidenceIds);
	return citations.filter((citation) => selected.has(citation.id));
}

export function createTableRuntimePorts({
	structured,
	signal,
	assertAuthorized,
}: {
	structured: Pick<StructuredOutputAdapter, "planTable">;
	signal: AbortSignal | undefined;
	assertAuthorized: () => Promise<void>;
}): Pick<AskGraphContext["ports"], "buildTablePlan" | "tableExecute"> {
	return {
		buildTablePlan: async (state) => {
			const candidates = tableCandidates(
				(state.citations ?? []) as InternalCitation[],
			);
			if (!candidates.length) {
				return {
					table_query_plan: { invalid: true },
					refuse_reason: "table_incomplete",
				};
			}
			const candidateHeaders = candidates.map(({ tableId, headers }) => ({
				tableId,
				headers,
			}));
			const groundedPlan = deriveGroundedTableLookup(
				state.question ?? "",
				candidates,
			);
			if (state.upgrade_reason === "grounded_table_lookup" && !groundedPlan) {
				return {
					table_query_plan: { invalid: true },
					refuse_reason: "table_incomplete",
				};
			}
			const deterministicPlan =
				groundedPlan ??
				deriveDeterministicTablePlan(state.question ?? "", candidateHeaders);
			if (deterministicPlan) {
				return { table_query_plan: deterministicPlan };
			}
			await assertAuthorized();
			const generatedPlan = await structured.planTable(
				{
					question: state.question ?? "",
					tables: candidateHeaders,
				},
				{
					abortSignal: signal,
					beforeRequest: assertAuthorized,
				},
			);
			const plan = normalizeTablePlanForQuestion(
				state.question ?? "",
				generatedPlan,
				candidates,
			);
			return { table_query_plan: plan };
		},
		tableExecute: (state) => {
			const citations = (state.citations ?? []) as InternalCitation[];
			const parsed = TableQueryPlanSchema.safeParse(state.table_query_plan);
			if (!parsed.success) {
				return {
					answer: "没有足够的表格结构信息来可靠执行该问题。",
					citations: [],
					refused: true,
					refuse_reason: "table_incomplete",
					judgement: {
						sufficient: false,
						action: "refuse",
						reason: "table_incomplete",
					},
				};
			}
			const plan: TableQueryPlan = parsed.data;
			const execution = executePlannedTableQuery(plan, citations);
			if (!execution) {
				return {
					answer: "无法唯一确定要执行的表格。",
					citations: [],
					refused: true,
					refuse_reason: "table_incomplete",
					judgement: {
						sufficient: false,
						action: "refuse",
						reason: "table_id_unavailable",
					},
				};
			}
			if (execution.status !== "success") {
				const clarify = execution.status === "clarify";
				return {
					answer: clarify
						? "请明确要查询的表格列或比较对象。"
						: "无法根据现有表格结构可靠执行该问题。",
					citations: [],
					table_execution: execution,
					refused: true,
					refuse_reason: "table_incomplete",
					judgement: {
						sufficient: false,
						action: clarify ? "clarify" : "refuse",
						reason: "table_incomplete",
					},
				};
			}
			return {
				table_execution: execution,
				retrieval_debug: {
					...(state.retrieval_debug ?? {}),
					judge_mode: "deterministic_table_execution",
					judge_model: null,
					judge_provider: null,
				},
				citations: selectEvidenceCitations(
					citations,
					execution.evidence.map((item) => item.citationId),
				),
			};
		},
	};
}
