import assert from "node:assert/strict";
import test from "node:test";
import type { AuthorizedScope } from "../../src/core/contracts";
import { DocumentIRSchema } from "../../src/core/document-ir";
import {
	buildDocumentContext,
	documentContextText,
} from "../../src/core/document-ir/document-context";
import type { QdrantSearchHit } from "../../src/core/retrieval/qdrant/payload";
import type { RetrievalVectorStore } from "../../src/core/retrieval/qdrant/store";
import {
	DefaultRetrievalService,
	RetrievalSecurityViolationError,
} from "../../src/core/retrieval/retrieval-service";
import {
	documentEvidenceFilters,
	resolveAskDocumentEvidence,
} from "../../src/server/http/ask/document-evidence";

const scope: AuthorizedScope = {
	organizationId: "org",
	workspaceId: "ws",
	libraryIds: ["lib"],
	principalIds: ["user"],
	groupIds: [],
	activeGenerationIds: ["gen", "other-gen"],
};
const context = buildDocumentContext(
	DocumentIRSchema.parse({
		id: "doc",
		title: "Instructions",
		nodes: [
			{ id: "h", type: "heading", level: 1, text: "Instructions" },
			{ id: "h2a", type: "heading", level: 2, text: "Accounts" },
			{ id: "h2b", type: "heading", level: 2, text: "Auditing" },
		],
	}),
);
const doc = {
	documentId: "doc",
	generationId: "gen",
	filename: "manual.docx",
	context,
};
const source: QdrantSearchHit = {
	id: "point",
	score: 0,
	payload: {
		library_id: "lib",
		doc_id: "doc",
		title: "Instructions",
		chunk_index: 0,
		text: documentContextText(context),
		body: documentContextText(context),
		document_version_id: "version",
		generation_id: "gen",
		tenant_id: "org",
		workspace_id: "ws",
		acl_scope: "workspace",
		record_type: "document",
	},
};
const embeddings = {
	async embedQuery() {
		throw Error("exact lookup must not embed");
	},
	async embedTexts() {
		return [];
	},
};
const options = {
	hybridEnabled: false,
	rerankEnabled: false,
	rerankTopK: 6,
	bm25TopK: 20,
	rrfK: 60,
};

function service(listCorpus: RetrievalVectorStore["listCorpus"]) {
	return new DefaultRetrievalService(
		embeddings,
		{
			async search() {
				throw Error("exact lookup must not vector search");
			},
			listCorpus,
		},
		null,
		options,
	);
}

test("outline replanning removes only the internal text default, never explicit resource constraints", () => {
	assert.deepEqual(
		documentEvidenceFilters({
			record_type: "text",
			doc_id: "doc",
			document_version_id: "version",
			table_id: "table",
		}),
		{
			record_type: undefined,
			doc_id: "doc",
			document_version_id: "version",
			table_id: "table",
		},
	);
	assert.deepEqual(documentEvidenceFilters({ record_type: "chunk" }), {
		record_type: "chunk",
	});
	assert.equal(documentEvidenceFilters(undefined), undefined);
});

test("exact outline lookup keeps mandatory scope, records a real zero score and executes complete headings", async () => {
	let called = 0;
	const retrieval = service(async (input) => {
		called++;
		assert.deepEqual(input.scope.documentIds, ["doc"]);
		assert.deepEqual(input.scope.activeGenerationIds, ["gen"]);
		assert.equal(input.scope.tenantId, "org");
		assert.equal(input.scope.workspaceId, "ws");
		assert.deepEqual(input.scope.principalIds, ["user"]);
		assert.deepEqual(input.userFilters, { record_type: "document" });
		return [source];
	});
	const resolution = await resolveAskDocumentEvidence({
		question: "manual.docx 的二级标题有哪些？",
		libraryId: "lib",
		scope,
		loadCatalog: async () => ({ documents: [doc], complete: true }),
		lookupDocumentRecord: (input) => retrieval.lookupDocumentRecord(input),
	});
	assert.equal(resolution.status, "resolved");
	assert.match(resolution.outline?.text ?? "", /Accounts[\s\S]*Auditing/);
	assert.equal(resolution.outline?.citation.score, 0);
	assert.equal(resolution.outline?.citation.dense_score, null);
	assert.equal(called, 1);
});

test("document lookup rejects wrong generation, workspace, document and ACL even if the store returns them", async () => {
	for (const payload of [
		{ ...source.payload, generation_id: "old-gen" },
		{ ...source.payload, workspace_id: "other-ws" },
		{ ...source.payload, doc_id: "other-doc" },
		{
			...source.payload,
			acl_scope: "restricted" as const,
			acl_principal_ids: ["other-user"],
		},
	]) {
		await assert.rejects(
			() =>
				service(async () => [{ ...source, payload }]).lookupDocumentRecord({
					libraryId: "lib",
					scope,
					documentId: "doc",
					generationId: "gen",
					expectedBody: source.payload.text,
				}),
			RetrievalSecurityViolationError,
		);
	}
});

test("exact outline lookup refuses duplicate records and mismatched metadata, rather than presenting partial structure", async () => {
	for (const hits of [
		[source, { ...source, id: "duplicate" }],
		[{ ...source, payload: { ...source.payload, body: "incomplete" } }],
	]) {
		assert.equal(
			await service(async () => hits).lookupDocumentRecord({
				libraryId: "lib",
				scope,
				documentId: "doc",
				generationId: "gen",
				expectedBody: source.payload.text,
			}),
			null,
		);
	}
});

test("exact structure lookup respects caller record, table, document and version filters", async () => {
	let calls = 0;
	const retrieval = service(async (input) => {
		calls++;
		assert.equal(input.userFilters?.document_version_id, "different-version");
		return [source];
	});
	for (const filters of [
		{ record_type: "chunk" as const },
		{ table_id: "table" },
		{ doc_id: "other-doc" },
		{ document_version_id: "different-version" },
	]) {
		assert.equal(
			await retrieval.lookupDocumentRecord({
				libraryId: "lib",
				scope,
				documentId: "doc",
				generationId: "gen",
				expectedBody: source.payload.text,
				filters,
			}),
			null,
		);
	}
	assert.equal(calls, 1);
});

test("ordinary asks avoid catalog work; filename asks narrow scope without changing caller filters", async () => {
	const fail = async () => {
		throw Error("unexpected catalog or structured lookup");
	};
	assert.equal(
		(
			await resolveAskDocumentEvidence({
				question: "What is the retention policy?",
				libraryId: "lib",
				scope,
				loadCatalog: fail,
				lookupDocumentRecord: fail,
			})
		).status,
		"none",
	);
	const result = await resolveAskDocumentEvidence({
		question: "manual.docx 的审批时间是什么？",
		libraryId: "lib",
		scope,
		loadCatalog: async () => ({ documents: [doc], complete: true }),
		lookupDocumentRecord: fail,
	});
	assert.deepEqual(result.scope.documentIds, ["doc"]);
	assert.deepEqual(result.scope.activeGenerationIds, ["gen"]);
	assert.equal(result.outline, undefined);
});

test("scope intersections, stale catalog versions and incomplete structure fail closed", async () => {
	const base = {
		question: "manual.docx 的二级标题有哪些？",
		libraryId: "lib",
		scope,
		loadCatalog: async () => ({ documents: [doc], complete: true }),
		lookupDocumentRecord: async () => null,
	};
	assert.equal(
		(
			await resolveAskDocumentEvidence({
				...base,
				scope: { ...scope, documentIds: [] },
			})
		).status,
		"unavailable",
	);
	assert.equal(
		(
			await resolveAskDocumentEvidence({
				...base,
				scope: { ...scope, activeGenerationIds: ["new-gen"] },
			})
		).status,
		"unavailable",
	);
	assert.equal(
		(
			await resolveAskDocumentEvidence({
				...base,
				filters: { doc_id: "other" },
			})
		).status,
		"unavailable",
	);
	assert.equal(
		(await resolveAskDocumentEvidence(base)).status,
		"outline_unavailable",
	);
});

test("a quoted release title shorthand resolves only a unique authorized active source", async () => {
	const title = "发布收口验收";
	const release = {
		...doc,
		filename: "release-closeout.md",
		context: { ...doc.context, title: `UnoRAG v0.2.8 ${title}` },
	};
	const resolve = (
		documents: (typeof release)[],
		requestScope = scope,
		question = `当前这份《${title}》记录的香港正式发布版本号是什么？对应的源码提交 SHA 是什么？不要列候选版。`,
		complete = true,
	) =>
		resolveAskDocumentEvidence({
			question,
			libraryId: "lib",
			scope: requestScope,
			loadCatalog: async () => ({ documents, complete }),
			lookupDocumentRecord: async () => {
				assert.fail("a fact query must not use exact outline execution");
			},
		});
	const previous = {
		...release,
		generationId: "old-gen",
		context: { ...release.context, title: `v0.2.7 ${title}` },
	};
	const previousScope = { ...scope, activeGenerationIds: ["old-gen"] };
	assert.deepEqual((await resolve([previous], previousScope)).scope, {
		...previousScope,
		documentIds: ["doc"],
	});
	assert.deepEqual((await resolve([release])).scope, {
		...scope,
		documentIds: ["doc"],
		activeGenerationIds: ["gen"],
	});
	assert.equal((await resolve([previous])).status, "unavailable");
	assert.equal((await resolve([])).status, "unavailable");
	assert.equal(
		(await resolve([release], { ...scope, documentIds: [] })).status,
		"unavailable",
	);
	assert.equal(
		(await resolve([release], scope, undefined, false)).status,
		"unavailable",
	);
	assert.equal(
		(await resolve([release, { ...previous, documentId: "other" }])).status,
		"ambiguous",
	);
	assert.equal(
		(
			await resolve(
				[release, { ...release, documentId: "other" }],
				scope,
				`《UnoRAG v0.2.8 ${title}》的版本号？`,
			)
		).status,
		"ambiguous",
	);
	assert.equal(
		(await resolve([release], scope, "《收口验收》记录了哪个版本？")).status,
		"unavailable",
	);
	assert.equal(
		(await resolve([release], scope, "《发布收口验收》的二级标题有哪些？"))
			.status,
		"unavailable",
	);
});
