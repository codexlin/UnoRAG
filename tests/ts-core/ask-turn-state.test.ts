import assert from "node:assert/strict";
import test from "node:test";

import {
	askTurnsReducer,
	toApiCitation,
	toUiCitation,
} from "../../src/components/app/ask-turn-state";

test("ask reducer preserves first evidence latency while streaming", () => {
	let turns = askTurnsReducer([], {
		type: "begin",
		turn: {
			id: "pending-1",
			question: "question",
			answer: "",
			citations: [],
			pending: true,
		},
	});
	turns = askTurnsReducer(turns, {
		type: "citations",
		turnId: "pending-1",
		citations: [],
		evidenceMs: 42,
	});
	turns = askTurnsReducer(turns, {
		type: "citations",
		turnId: "pending-1",
		citations: [],
		evidenceMs: 99,
	});
	turns = askTurnsReducer(turns, {
		type: "token",
		turnId: "pending-1",
		token: "answer",
	});

	assert.equal(turns[0]?.evidenceMs, 42);
	assert.equal(turns[0]?.answer, "answer");
});

test("citation mapper round-trips persisted fields", () => {
	const api = {
		id: "citation-1",
		index: 1,
		title: "Policy",
		page: "3",
		section_path: "Leave > Approval",
		preamble: "Employee handbook",
		snippet: "three days",
		text: "Approval takes three days.",
		score: 0.9,
		dense_score: 0.8,
		bm25_score: 0.7,
		rrf_score: 0.6,
		used_rerank: true,
		used_hybrid: true,
		doc_id: "document-1",
		document_version_id: "version-1",
		table_id: "table-1",
		record_type: "table_rows",
		record_id: "row-group-1",
		row_start: 2,
		row_end: 3,
		headers: ["Owner", "Cost"],
		rows: [["Alice", "100"]],
		source_chunk_ids: ["chunk-1"],
		source_node_ids: ["node-1"],
		chunk_index: 2,
		filename: "handbook.pdf",
	};

	assert.deepEqual(toApiCitation(toUiCitation(api)), api);
	const alias = { ...api, doc_id: null, document_id: "document-1" };
	assert.equal(toUiCitation(alias).docId, "document-1");
	assert.deepEqual(toApiCitation(toUiCitation(alias)), alias);
});
