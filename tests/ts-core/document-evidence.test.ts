import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentContext } from "../../src/core/document-ir/document-context";
import type { InternalCitation } from "../../src/core/retrieval";
import type { ActiveDocumentDescriptor } from "../../src/core/retrieval/document-constraints";
import { evidenceDocumentContext } from "../../src/server/http/ask/document-evidence";

type EvidenceIdentity = Pick<InternalCitation, "doc_id" | "generation_id">;
const citation: EvidenceIdentity = {
	doc_id: "doc-alpha",
	generation_id: "generation-alpha",
};

function context(overrides: Partial<DocumentContext> = {}): DocumentContext {
	return {
		version: 1,
		title: "Project Alpha Architecture",
		filename: "project.md",
		identifiers: ["PROJECT-ALPHA-001"],
		identifiers_complete: true,
		outline_complete: true,
		outline: [
			{
				node_id: "heading-alpha",
				text: "Private outline detail",
				level: 1,
				page: 1,
			},
		],
		...overrides,
	};
}

function document(
	overrides: Partial<ActiveDocumentDescriptor> = {},
): ActiveDocumentDescriptor {
	return {
		documentId: citation.doc_id,
		generationId: "generation-alpha",
		filename: "project.md",
		context: context(),
		...overrides,
	};
}

test("identity context binds exact document and generation, not a shared filename", () => {
	const alpha = document();
	const beta = document({
		documentId: "doc-beta",
		generationId: "generation-beta",
		context: context({
			title: "Project Beta Operations",
			identifiers: ["PROJECT-BETA-001"],
		}),
	});
	assert.deepEqual(evidenceDocumentContext(citation, [beta, alpha]), {
		title: "Project Alpha Architecture",
		filename: "project.md",
		identifiers: ["PROJECT-ALPHA-001"],
	});
	assert.deepEqual(
		evidenceDocumentContext(
			{ doc_id: "doc-beta", generation_id: "generation-beta" },
			[alpha, beta],
		),
		{
			title: "Project Beta Operations",
			filename: "project.md",
			identifiers: ["PROJECT-BETA-001"],
		},
	);
});

test("missing or mismatched identities fail closed without filename inference", () => {
	for (const identity of [
		{ doc_id: "missing-doc", generation_id: "generation-alpha" },
		{ doc_id: "doc-alpha", generation_id: "old-generation" },
		{ doc_id: "doc-alpha", generation_id: "generation-beta" },
		{ doc_id: "DOC-ALPHA", generation_id: "generation-alpha" },
		{ doc_id: " doc-alpha", generation_id: "generation-alpha" },
	]) {
		assert.equal(evidenceDocumentContext(identity, [document()]), null);
	}
	assert.equal(evidenceDocumentContext(citation, []), null);
});

test("null, empty and missing citation identifiers never bind", () => {
	for (const identity of [
		{ ...citation, doc_id: "" },
		{ ...citation, doc_id: " " },
		{ ...citation, generation_id: null },
		{ ...citation, generation_id: "" },
		{ ...citation, generation_id: " " },
		{ doc_id: "doc-alpha" },
		{ generation_id: "generation-alpha" },
	]) {
		assert.equal(
			evidenceDocumentContext(identity as EvidenceIdentity, [document()]),
			null,
		);
	}
});

test("duplicate exact bindings fail closed even if only one context is valid", () => {
	for (const duplicate of [
		document(),
		document({ context: context({ title: "Different project title" }) }),
		document({ context: null }),
	]) {
		assert.equal(
			evidenceDocumentContext(citation, [document(), duplicate]),
			null,
		);
	}
});

test("another generation of the same document cannot replace the exact binding", () => {
	const current = document();
	const other = document({
		generationId: "other-generation",
		context: context({ title: "Project Alpha Earlier Draft" }),
	});
	assert.equal(evidenceDocumentContext(citation, [other]), null);
	assert.equal(
		evidenceDocumentContext(citation, [other, current])?.title,
		"Project Alpha Architecture",
	);
});

test("missing, null and invalid full contexts are rejected rather than partially trusted", () => {
	const { outline: _outline, ...identityOnly } = context();
	const invalid: Record<string, unknown> = {
		missing: undefined,
		null: null,
		identityOnly,
		wrongVersion: { ...context(), version: 2 },
		unknownField: { ...context(), prompt: "Untrusted extra field" },
		longTitle: context({ title: "T".repeat(513) }),
		longFilename: context({ filename: "F".repeat(513) }),
		tooManyIdentifiers: context({ identifiers: Array(33).fill("ID") }),
		longIdentifier: context({ identifiers: ["I".repeat(129)] }),
		emptyIdentifier: context({ identifiers: [""] }),
		invalidOutline: {
			...context(),
			outline: [{ node_id: "heading", text: "Heading", level: 7, page: 1 }],
		},
	};
	for (const [name, value] of Object.entries(invalid)) {
		assert.equal(
			evidenceDocumentContext(citation, [
				document({ context: value as DocumentContext }),
			]),
			null,
			name,
		);
	}
});

test("schema boundary values are preserved without truncation or full outline disclosure", () => {
	const bounded = context({
		title: "T".repeat(512),
		filename: "F".repeat(512),
		identifiers: Array.from({ length: 32 }, (_, index) =>
			`ID-${index}`.padEnd(128, "X"),
		),
		identifiers_complete: false,
		outline_complete: false,
	});
	const result = evidenceDocumentContext(citation, [
		document({ context: bounded }),
	]);
	assert.deepEqual(result, {
		title: bounded.title,
		filename: bounded.filename,
		identifiers: bounded.identifiers,
	});
	assert.deepEqual(Object.keys(result ?? {}).sort(), [
		"filename",
		"identifiers",
		"title",
	]);
	assert.equal(
		JSON.stringify(result).includes("Private outline detail"),
		false,
	);
});

test("projection does not mutate catalog inputs or share a mutable identifiers array", () => {
	const doc = document();
	assert.ok(doc.context);
	const documents = [doc];
	const before = structuredClone(documents);
	Object.freeze(doc.context.identifiers);
	for (const heading of doc.context.outline) Object.freeze(heading);
	Object.freeze(doc.context.outline);
	Object.freeze(doc.context);
	Object.freeze(doc);
	Object.freeze(documents);
	const result = evidenceDocumentContext(
		Object.freeze({ ...citation }),
		documents,
	);
	assert.ok(result);
	assert.notEqual(result.identifiers, doc.context.identifiers);
	result.identifiers.push("OUTPUT-ONLY");
	result.title = "Changed projection";
	assert.deepEqual(documents, before);
	assert.deepEqual(evidenceDocumentContext(citation, documents), {
		title: "Project Alpha Architecture",
		filename: "project.md",
		identifiers: ["PROJECT-ALPHA-001"],
	});
});
