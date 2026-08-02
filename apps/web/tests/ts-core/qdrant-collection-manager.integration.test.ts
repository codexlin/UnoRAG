import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { QdrantClient } from "@qdrant/js-client-rest";
import {
	QdrantCollectionManager,
	UNORAG_QDRANT_PAYLOAD_INDEXES,
} from "../../src/core/retrieval/qdrant/collection-manager";
import { parseStoredQdrantPayload } from "../../src/core/retrieval/qdrant/payload";

const qdrantUrl =
	process.env.QDRANT_COLLECTION_E2E_URL?.trim() ||
	process.env.QDRANT_INGEST_E2E_URL?.trim();

test("real Qdrant collection ensure is idempotent and materializes filter indexes", {
	skip: qdrantUrl
		? false
		: "QDRANT_COLLECTION_E2E_URL or QDRANT_INGEST_E2E_URL is not configured",
}, async () => {
	assert.ok(qdrantUrl);
	const client = new QdrantClient({
		url: qdrantUrl,
		checkCompatibility: true,
	});
	const collection = `unorag_contract_e2e_${randomUUID().replaceAll("-", "")}`;
	const manager = new QdrantCollectionManager(client, {
		collection,
		vectorSize: 2,
		distance: "Cosine",
	});

	try {
		const first = await manager.ensure();
		const second = await manager.ensure();
		const info = await client.getCollection(collection);

		assert.equal(first.created, true);
		assert.deepEqual(first, second);
		assert.equal(
			"size" in (info.config.params.vectors ?? {})
				? info.config.params.vectors?.size
				: undefined,
			2,
		);
		for (const index of UNORAG_QDRANT_PAYLOAD_INDEXES) {
			assert.equal(info.payload_schema[index.fieldName]?.data_type, "keyword");
		}

		const pointId = randomUUID();
		const upsert = await client.upsert(collection, {
			wait: true,
			ordering: "strong",
			points: [{ id: pointId, vector: [1, 0], payload: tablePayload() }],
		});
		assert.equal(upsert.status, "completed");
		const point = (await client.retrieve(collection, { ids: [pointId] }))[0];
		const payload = parseStoredQdrantPayload(point?.payload);
		assert.ok(payload);
		assert.equal(payload.table_columns?.[1]?.unit, "CNY");
		assert.equal(payload.cell_rows?.[0]?.cells[1]?.normalized_value, 120000);
		assert.deepEqual(payload.cell_rows?.[0]?.cells[1]?.bbox, [31, 20, 60, 40]);
		assert.equal(payload.table_quality?.cross_page_merged, true);
	} finally {
		if ((await client.collectionExists(collection)).exists) {
			await client.deleteCollection(collection);
		}
	}
});

function tablePayload(): Record<string, unknown> {
	return {
		library_id: "library-1",
		doc_id: "document-1",
		title: "报价",
		chunk_index: 0,
		text: "项目 | 金额\n服务费 | 120000",
		document_version_id: "version-1",
		generation_id: "generation-1",
		tenant_id: "tenant-1",
		workspace_id: "workspace-1",
		lifecycle_visibility: "active",
		acl_scope: "workspace",
		acl_principal_ids: [],
		acl_group_ids: [],
		record_type: "table",
		record_id: "table-record-1",
		table_id: "table-1",
		table_caption: "报价清单",
		headers: ["项目", "金额"],
		rows: [["服务费", "120000"]],
		row_start: 0,
		row_end: 0,
		table_row_count: 1,
		header_rows: [["项目", "金额（元）"]],
		table_columns: [
			{
				name: "项目",
				normalized_name: "项目",
				data_type: "string",
				unit: null,
			},
			{
				name: "金额",
				normalized_name: "金额",
				data_type: "currency",
				unit: "CNY",
			},
		],
		cell_rows: [
			{
				cells: [
					{
						raw_text: "服务费",
						normalized_value: "服务费",
						page: 2,
						bbox: [10, 20, 30, 40],
						confidence: 0.99,
						rowspan: 1,
						colspan: 1,
					},
					{
						raw_text: "￥120,000",
						normalized_value: 120000,
						page: 2,
						bbox: [31, 20, 60, 40],
						confidence: 0.97,
						rowspan: 1,
						colspan: 1,
					},
				],
			},
		],
		summary_rows: [],
		footnotes: ["金额含税"],
		table_quality: {
			score: 0.96,
			executable: true,
			header_inferred: false,
			header_confidence: 0.99,
			expected_columns: 2,
			irregular_row_count: 0,
			low_confidence_cell_count: 0,
			cross_page_merged: true,
			warnings: [],
		},
		source_chunk_ids: [],
		source_node_ids: [],
	};
}
