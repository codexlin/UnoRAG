import assert from "node:assert/strict";
import test from "node:test";
import { chunkDocument } from "../../src/core/ingest/chunking";
import { normalizeMinerUResult } from "../../src/core/parsing/mineru-provider";

test("MinerU image footnotes survive IR, chunk text and source lineage", async () => {
	const result = normalizeMinerUResult(
		{
			content_list: [
				{
					type: "image",
					image_caption: ["图2 压力管路示意"],
					image_footnote: ["维护前必须卸压，禁止带压操作。"],
					page_idx: 2,
					bbox: [10, 20, 100, 200],
				},
			],
		},
		{
			documentId: "manual",
			providerVersion: "2.5",
			providerTaskId: "test-task",
		},
	);
	const node = result.document.nodes[0];
	assert.ok(node);
	assert.equal(node.type, "figure");
	assert.match(node.text, /压力管路示意/);
	assert.match(node.text, /维护前必须卸压/);
	assert.equal(node.figure_desc, node.text);
	assert.equal(node.page_start, 3);
	assert.deepEqual(node.meta.bbox, [10, 20, 100, 200]);
	const chunks = await chunkDocument(result.document);
	const chunk = chunks.find((item) => item.figure_id === node.figure_id);
	assert.ok(chunk);
	assert.match(chunk.body, /维护前必须卸压/);
	assert.ok(chunk.node_ids.includes(node.id));
});

test("MinerU img aliases retain footnotes without captions and do not duplicate identical descriptions", () => {
	const result = normalizeMinerUResult(
		{
			content_list: [
				{
					type: "image",
					text: "图3 外壳结构",
					img_caption: ["图3 外壳结构"],
					img_footnote: ["外壳冷却后才能拆卸。"],
					page_idx: 0,
				},
				{
					type: "figure",
					img_footnote: ["仅供经过授权的维护人员使用。"],
					page_idx: 1,
				},
			],
		},
		{
			documentId: "manual",
			providerVersion: "2.5",
			providerTaskId: "test-task",
		},
	);
	assert.equal(
		result.document.nodes[0]?.text,
		"图3 外壳结构\n\n外壳冷却后才能拆卸。",
	);
	assert.equal(result.document.nodes[1]?.text, "仅供经过授权的维护人员使用。");
});
