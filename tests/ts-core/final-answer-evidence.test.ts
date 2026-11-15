import assert from "node:assert/strict";
import test from "node:test";
import { AnswerCitationValidationError } from "../../src/core/ai/answer-citations";
import { selectFinalAnswerEvidence } from "../../src/core/ask-graph/answer-evidence";

type Evidence = Record<string, unknown> & { index: number };

function evidence(
	index: number,
	overrides: Record<string, unknown> = {},
): Evidence {
	return {
		id: `source-${index}`,
		index,
		record_type: "chunk",
		record_id: `chunk-${index}`,
		doc_id: "document-a",
		document_version_id: "version-a",
		generation_id: "generation-a",
		tenant_id: "organization-a",
		workspace_id: "workspace-a",
		library_id: "library-a",
		table_id: null,
		figure_id: null,
		source_chunk_ids: [],
		source_node_ids: [],
		...overrides,
	};
}

test("anchored prose retains already-selected figure, table and table-summary companions", () => {
	const prose = evidence(1, {
		figure_id: "figure-a",
		table_id: "table-a",
		source_chunk_ids: ["parent-table"],
		source_node_ids: ["node-a"],
	});
	const figure = evidence(2, {
		record_type: "figure",
		figure_id: "figure-a",
	});
	const table = evidence(3, { record_type: "table", table_id: "table-a" });
	const summary = evidence(4, {
		record_type: "table_summary",
		source_chunk_ids: [prose.record_id],
	});
	const nodeFigure = evidence(5, {
		record_type: "figure",
		source_node_ids: ["node-a"],
	});
	const parentTable = evidence(6, {
		record_type: "table",
		record_id: "parent-table",
	});
	const candidates = [prose, figure, table, summary, nodeFigure, parentTable];
	const before = structuredClone(candidates);
	for (const candidate of candidates) Object.freeze(candidate);
	Object.freeze(candidates);
	const selected = selectFinalAnswerEvidence(
		"Supported answer [1].",
		candidates,
	);
	assert.deepEqual(selected, candidates);
	assert.deepEqual(candidates, before);
	assert.notEqual(selected, candidates);
	for (const source of selected) assert.ok(candidates.includes(source));
});

for (const key of [
	"doc_id",
	"document_version_id",
	"generation_id",
	"tenant_id",
	"workspace_id",
	"library_id",
] as const) {
	test(`a related companion from another ${key} is excluded`, () => {
		const prose = evidence(1, {
			figure_id: "shared-figure",
			table_id: "shared-table",
		});
		for (const record_type of ["figure", "table", "table_summary"]) {
			const foreign = evidence(2, {
				record_type,
				figure_id: record_type === "figure" ? "shared-figure" : null,
				table_id: record_type === "figure" ? null : "shared-table",
				[key]: "another-scope",
			});
			assert.deepEqual(
				selectFinalAnswerEvidence("Answer [1].", [prose, foreign]),
				[prose],
				record_type,
			);
		}
	});
}

test("companions require a present nonempty matching generation on both sides", () => {
	for (const missing of [undefined, null, "", " "]) {
		for (const side of ["source", "companion", "both"]) {
			const prose = evidence(1, {
				figure_id: "shared-figure",
				...(side !== "companion" ? { generation_id: missing } : {}),
			});
			const figure = evidence(2, {
				record_type: "figure",
				figure_id: "shared-figure",
				...(side !== "source" ? { generation_id: missing } : {}),
			});
			assert.deepEqual(
				selectFinalAnswerEvidence("Answer [1].", [prose, figure]),
				[prose],
				`${side}: ${String(missing)}`,
			);
		}
	}
});

test("unrelated visual records and unanchored ordinary prose are dropped", () => {
	const anchored = evidence(3, { source_node_ids: ["shared-node"] });
	const relatedProse = evidence(1, { source_node_ids: ["shared-node"] });
	const unrelated = [
		"chunk",
		"section",
		"document",
		"figure",
		"table",
		"table_summary",
	].map((record_type, index) => evidence(index + 4, { record_type }));
	assert.deepEqual(
		selectFinalAnswerEvidence("Answer [3].", [
			relatedProse,
			anchored,
			...unrelated,
		]),
		[anchored],
	);
});

test("lineage expansion is direct only, regardless of candidate ordering", () => {
	const anchored = evidence(1, { source_node_ids: ["root-node"] });
	const bridge = evidence(2, {
		record_type: "figure",
		source_node_ids: ["root-node", "second-hop-node"],
	});
	const secondHop = evidence(3, {
		record_type: "table_summary",
		source_node_ids: ["second-hop-node"],
	});
	assert.deepEqual(
		selectFinalAnswerEvidence("Answer [1].", [anchored, bridge, secondHop]),
		[anchored, bridge],
	);
	assert.deepEqual(
		selectFinalAnswerEvidence("Answer [1].", [secondHop, bridge, anchored]),
		[bridge, anchored],
	);
});

test("direct figure and prose citations preserve their original sparse indices", () => {
	const unused = evidence(1);
	const prose = evidence(3);
	const figure = evidence(8, { record_type: "figure" });
	const candidates = [unused, prose, figure];
	assert.deepEqual(
		selectFinalAnswerEvidence("Figure [8], then prose [3].", candidates),
		[prose, figure],
	);
	assert.deepEqual(
		candidates.map((citation) => citation.index),
		[1, 3, 8],
	);
});

test("anchorless answers and explicitly preserved refusals keep all selected evidence", () => {
	const candidates = [evidence(1), evidence(4, { record_type: "figure" })];
	for (const answer of [
		"",
		"No inline anchors.",
		"`[4]` \\[4] [4](https://example.test)",
	])
		assert.deepEqual(selectFinalAnswerEvidence(answer, candidates), candidates);
	for (const answer of ["Cannot answer [1].", "Source item[2026] [1,2]."])
		assert.deepEqual(
			selectFinalAnswerEvidence(answer, candidates, { preserveAll: true }),
			candidates,
		);
});

test("invalid model anchors still fail instead of selecting companions or falling back", () => {
	const candidates = [
		evidence(1, { figure_id: "figure-a" }),
		evidence(2, { record_type: "figure", figure_id: "figure-a" }),
	];
	for (const anchor of ["[99]", "[0]", "[01]", "[1,2]", "[1", "[1] [99]"])
		assert.throws(
			() => selectFinalAnswerEvidence(`Answer ${anchor}`, candidates),
			AnswerCitationValidationError,
		);
});
