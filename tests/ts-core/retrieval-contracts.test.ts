import assert from "node:assert/strict";
import { test } from "node:test";

import { mapQdrantHitToInternalCitation } from "../../src/core/retrieval/citation-mapper";
import {
	buildMandatoryQdrantFilter,
	NO_ACTIVE_GENERATION_SENTINELS,
	NO_ALLOWED_DOCUMENT_SENTINELS,
} from "../../src/core/retrieval/filters/qdrant-filter";
import {
	parseQdrantSearchHit,
	parseStoredQdrantPayload,
} from "../../src/core/retrieval/qdrant/payload";

const scope = {
	tenantId: "tenant-a",
	workspaceId: "workspace-a",
	libraryId: "library-a",
	principalIds: ["user-a", "service-key-a"],
	groupIds: ["finance", "legal"],
	activeGenerationIds: ["generation-current"],
};

function fieldConditions(value: unknown): Array<Record<string, unknown>> {
	const found: Array<Record<string, unknown>> = [];
	const visit = (item: unknown) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return;
		const record = item as Record<string, unknown>;
		if (typeof record.key === "string" && record.match) found.push(record);
		for (const child of Object.values(record)) {
			if (Array.isArray(child)) child.forEach(visit);
			else visit(child);
		}
	};
	visit(value);
	return found;
}

function conditionFor(filter: unknown, key: string) {
	return fieldConditions(filter).filter((condition) => condition.key === key);
}

test("mandatory filter covers workspace, principal, group and active generation", () => {
	const filter = buildMandatoryQdrantFilter({
		scope,
		userFilters: { record_type: "chunk", doc_id: "document-a" },
	});

	assert.deepEqual(conditionFor(filter, "tenant_id"), [
		{ key: "tenant_id", match: { value: "tenant-a" } },
	]);
	assert.deepEqual(conditionFor(filter, "workspace_id"), [
		{ key: "workspace_id", match: { value: "workspace-a" } },
	]);
	assert.deepEqual(conditionFor(filter, "library_id"), [
		{ key: "library_id", match: { value: "library-a" } },
	]);
	assert.deepEqual(conditionFor(filter, "acl_principal_ids"), [
		{
			key: "acl_principal_ids",
			match: { any: ["user-a", "service-key-a"] },
		},
	]);
	assert.deepEqual(conditionFor(filter, "acl_group_ids"), [
		{ key: "acl_group_ids", match: { any: ["finance", "legal"] } },
	]);
	assert.deepEqual(conditionFor(filter, "generation_id"), [
		{ key: "generation_id", match: { any: ["generation-current"] } },
	]);
	assert.deepEqual(conditionFor(filter, "doc_id"), [
		{ key: "doc_id", match: { value: "document-a" } },
	]);
	assert.equal(JSON.stringify(filter).includes("generation-old"), false);
});

test("empty group scope keeps principal ACL separate and omits group MatchAny", () => {
	const filter = buildMandatoryQdrantFilter({
		scope: { ...scope, groupIds: [] },
	});

	assert.deepEqual(conditionFor(filter, "acl_principal_ids"), [
		{
			key: "acl_principal_ids",
			match: { any: ["user-a", "service-key-a"] },
		},
	]);
	assert.deepEqual(conditionFor(filter, "acl_group_ids"), []);
});

test("empty active generation snapshot produces an explicit match-none filter", () => {
	const filter = buildMandatoryQdrantFilter({
		scope: { ...scope, activeGenerationIds: [] },
	});
	const generationConditions = conditionFor(filter, "generation_id");

	assert.deepEqual(
		generationConditions.map((condition) => condition.match),
		NO_ACTIVE_GENERATION_SENTINELS.map((value) => ({ value })),
	);
	assert.equal(
		generationConditions.some((condition) => {
			const match = condition.match as { any?: unknown[] };
			return Array.isArray(match.any) && match.any.length === 0;
		}),
		false,
	);
});

test("document allow-list is mandatory and an empty list matches none", () => {
	const limited = buildMandatoryQdrantFilter({
		scope: { ...scope, documentIds: ["document-a", "document-b"] },
	});
	assert.deepEqual(conditionFor(limited, "doc_id"), [
		{ key: "doc_id", match: { any: ["document-a", "document-b"] } },
	]);

	const empty = buildMandatoryQdrantFilter({
		scope: { ...scope, documentIds: [] },
	});
	assert.deepEqual(
		conditionFor(empty, "doc_id").map((condition) => condition.match),
		NO_ALLOWED_DOCUMENT_SENTINELS.map((value) => ({ value })),
	);
});

test("caller filters cannot override security dimensions or add unknown fields", () => {
	for (const userFilters of [
		{ tenant_id: "tenant-b" },
		{ workspace_id: "workspace-b" },
		{ library_id: "library-b" },
		{ generation_id: "generation-old" },
		{ acl_scope: "workspace" },
		{ made_up: "value" },
	]) {
		assert.throws(() => buildMandatoryQdrantFilter({ scope, userFilters }));
	}
});

test("stored payload parsing strips unknown historical fields but fails closed on scope", () => {
	const parsed = parseStoredQdrantPayload({
		library_id: "library-a",
		doc_id: "document-a",
		title: "Policy",
		chunk_index: 0,
		text: "three working days",
		document_version_id: "version-a",
		generation_id: "generation-current",
		tenant_id: "tenant-a",
		workspace_id: "workspace-a",
		legacy_only_field: "must-not-cross-the-boundary",
	});

	assert.ok(parsed);
	assert.equal("legacy_only_field" in parsed, false);
	assert.equal(
		parseStoredQdrantPayload({
			library_id: "library-a",
			doc_id: "document-a",
			title: "Policy",
			chunk_index: 0,
			text: "unscoped",
			document_version_id: "version-a",
			tenant_id: "tenant-a",
		}),
		null,
	);
});

test("Qdrant hit maps to a strict internal citation without unknown payload fields", () => {
	const rawHit = {
		id: 42,
		score: 1.4,
		dense_score: 0.82,
		used_hybrid: true,
		payload: {
			library_id: "library-a",
			doc_id: "document-a",
			title: "Leave Policy",
			chunk_index: 3,
			text: "fallback text",
			body: "Proof is due within three working days.",
			document_version_id: "version-a",
			generation_id: "generation-current",
			tenant_id: "tenant-a",
			workspace_id: "workspace-a",
			record_type: "chunk",
			page: 2,
			source_chunk_ids: ["chunk-a"],
			unknown_secret: "drop-me",
		},
		unknown_point_field: "drop-me-too",
	};

	const parsedHit = parseQdrantSearchHit(rawHit);
	assert.ok(parsedHit);
	assert.equal("unknown_point_field" in parsedHit, false);
	assert.equal("unknown_secret" in parsedHit.payload, false);

	const citation = mapQdrantHitToInternalCitation(rawHit, 1);
	assert.equal(citation.id, "42");
	assert.equal(citation.page, "2");
	assert.equal(citation.body, "Proof is due within three working days.");
	assert.equal(citation.snippet, citation.body);
	assert.equal(citation.score, 1);
	assert.equal(citation.dense_score, 0.82);
	assert.equal(citation.used_hybrid, true);
	assert.equal(citation.generation_id, "generation-current");
	assert.deepEqual(citation.source_chunk_ids, ["chunk-a"]);
	assert.equal("unknown_secret" in citation, false);
});
