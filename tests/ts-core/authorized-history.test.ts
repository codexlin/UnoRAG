import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import type { AuthIdentity } from "../../src/lib/server/auth/provider";
import type { SessionMemoryMessage } from "../../src/server/conversations/session-memory";
import type { MemoryProvenance } from "../../src/server/http/ask/authorized-history";
import type { HistoricalCitationAuthorizer } from "../../src/server/http/ask/conversation-handler";

const require = createRequire(import.meta.url);
const nodeModule = require("node:module") as {
	_resolveFilename: (
		request: string,
		parent?: unknown,
		isMain?: boolean,
		options?: unknown,
	) => string;
};
const originalResolveFilename = nodeModule._resolveFilename.bind(nodeModule);
const inertServerOnlyModule = require.resolve("next/package.json");
nodeModule._resolveFilename = (request, parent, isMain, options) =>
	request === "server-only"
		? inertServerOnlyModule
		: originalResolveFilename(request, parent, isMain, options);
const modules = Promise.all([
	import("../../src/server/http/ask/authorized-history"),
	import("../../src/server/conversations/session-memory"),
]).finally(() => {
	nodeModule._resolveFilename = originalResolveFilename;
});

const identity: AuthIdentity = {
	tenantId: "organization-a",
	workspaceId: "workspace-a",
	workspaceName: "Workspace",
	principalId: "principal-a",
	groupIds: ["group-a"],
	organizationRole: "member",
	role: "viewer",
	email: null,
	displayName: "Viewer",
	provider: "local",
	mustChangePassword: false,
};
const libraryId = "library-a";

function reference(id = "a") {
	return {
		doc_id: `document-${id}`,
		document_version_id: `version-${id}`,
		generation_id: `generation-${id}`,
	};
}

function provenance(
	sources: MemoryProvenance["sourceReferences"] = [reference()],
): MemoryProvenance {
	return { version: 1, libraryId, sourceReferences: sources };
}

function exchange(
	marker: MemoryProvenance | undefined = provenance(),
	question = "question",
	answer = "answer",
): SessionMemoryMessage[] {
	return [
		{ role: "user", content: question },
		{ role: "assistant", content: answer, provenance: marker },
	];
}

function authorizer(revoked: string[] = []) {
	const calls: Parameters<
		HistoricalCitationAuthorizer["filterAuthorized"]
	>[0][] = [];
	const value: HistoricalCitationAuthorizer = {
		async filterAuthorized(input) {
			calls.push(input);
			return input.citations.filter(
				(citation) => !revoked.includes(String(citation.doc_id)),
			);
		},
	};
	return { value, calls };
}

test("source references sanitize and deduplicate without exposing content", async () => {
	const [{ sourceReferences }] = await modules;
	assert.deepEqual(
		sourceReferences([
			{
				...reference(),
				library_id: libraryId,
				tenant_id: identity.tenantId,
				workspace_id: identity.workspaceId,
				body: "private source",
				rows: [["private row"]],
				snippet: "private snippet",
			},
			{
				...reference(),
				library_id: libraryId,
				tenant_id: identity.tenantId,
				workspace_id: identity.workspaceId,
			},
		]),
		[
			{
				...reference(),
				library_id: libraryId,
				tenant_id: identity.tenantId,
				workspace_id: identity.workspaceId,
			},
		],
	);
	assert.deepEqual(
		sourceReferences([
			{
				document_id: "document-a",
				document_version_id: "version-a",
				generation_id: "generation-a",
			},
		]),
		[reference()],
	);
	assert.deepEqual(sourceReferences([]), []);
});

test("archive provenance requires exact server content and unions ambiguous matches", async () => {
	const [{ recoverArchiveProvenance }] = await modules;
	const messages = [
		...exchange(provenance([reference("a")])),
		...exchange(provenance([reference("b")])),
	];
	const input = { identity, libraryId, messages };
	assert.deepEqual(
		recoverArchiveProvenance({
			...input,
			turns: [
				{ question: "question", answer: "answer" },
				{ question: "edited", answer: "answer" },
				{ question: "question", answer: "forged answer" },
			],
		}),
		[provenance([reference("a"), reference("b")]), null, null],
	);
	assert.deepEqual(
		recoverArchiveProvenance({
			...input,
			libraryId: "other-library",
			turns: [{ question: "question", answer: "answer" }],
		}),
		[null],
	);
	assert.deepEqual(
		recoverArchiveProvenance({
			...input,
			messages: [],
			turns: [{ question: "question", answer: "answer" }],
		}),
		[null],
	);
});

test("archive recovery never bridges messages or discards unknown transitive sources", async () => {
	const [{ recoverArchiveProvenance }] = await modules;
	const turns = [{ question: "question", answer: "answer" }];
	for (const messages of [
		[
			...exchange(provenance()),
			...exchange({ ...provenance(), libraryId: "other" }),
		],
		[
			...exchange(provenance()),
			...exchange().map(({ role, content }) => ({ role, content })),
		],
		[
			{
				role: "assistant" as const,
				content: "answer",
				provenance: provenance(),
			},
			{ role: "user" as const, content: "question" },
		],
	]) {
		assert.deepEqual(
			recoverArchiveProvenance({ identity, libraryId, turns, messages }),
			[null],
		);
	}
});

test("any incomplete source invalidates extraction instead of disappearing", async () => {
	const [{ sourceReferences }] = await modules;
	for (const field of ["doc_id", "document_version_id", "generation_id"]) {
		const incomplete: Record<string, unknown> = reference("b");
		delete incomplete[field];
		assert.equal(sourceReferences([reference(), incomplete]), null, field);
		assert.equal(sourceReferences([{ ...reference(), [field]: " " }]), null);
	}
	assert.equal(
		sourceReferences([{ ...reference(), document_id: "different-document" }]),
		null,
	);
	assert.equal(
		sourceReferences([{ ...reference(), generation_id: "g".repeat(257) }]),
		null,
	);
});

test("provenance unions transitive dependencies and rejects overflow without truncation", async () => {
	const [
		{ createMemoryProvenance, MAX_MEMORY_SOURCE_REFERENCES, sourceReferences },
	] = await modules;
	assert.deepEqual(
		createMemoryProvenance(libraryId, [
			reference(),
			reference("b"),
			reference(),
		]),
		provenance([reference(), reference("b")]),
	);
	const tooMany = Array.from(
		{ length: MAX_MEMORY_SOURCE_REFERENCES + 1 },
		(_, index) => reference(String(index)),
	);
	assert.equal(sourceReferences(tooMany), null);
	assert.equal(createMemoryProvenance(libraryId, tooMany), null);
	assert.equal(
		createMemoryProvenance(libraryId, [{ doc_id: "missing-lineage" }]),
		null,
	);
});

test("active authorization can use a larger bounded budget without widening reusable memory", async () => {
	const [{ sourceReferences, createMemoryProvenance }] = await modules;
	const references = Array.from({ length: 1_025 }, (_, index) =>
		reference(`source-${index}`),
	);
	const aboveMemoryLimit = references.slice(0, 257);
	assert.equal(sourceReferences(aboveMemoryLimit), null);
	assert.deepEqual(sourceReferences(aboveMemoryLimit, 1_024), aboveMemoryLimit);
	assert.equal(createMemoryProvenance(libraryId, aboveMemoryLimit), null);
	assert.deepEqual(
		sourceReferences(references.slice(0, 1_024), 1_024),
		references.slice(0, 1_024),
	);
	assert.equal(sourceReferences(references, 1_024), null);
	assert.equal(sourceReferences(references, 10_000), null);
	assert.equal(
		sourceReferences([...aboveMemoryLimit, { doc_id: "incomplete" }], 1_024),
		null,
	);
	for (const maxReferences of [0, -1, 1.9, Number.NEGATIVE_INFINITY]) {
		assert.deepEqual(
			sourceReferences(references.slice(0, 1), maxReferences),
			references.slice(0, 1),
		);
		assert.equal(sourceReferences(references.slice(0, 2), maxReferences), null);
	}
	assert.equal(sourceReferences(aboveMemoryLimit, Number.NaN), null);
	assert.equal(sourceReferences(references, Number.POSITIVE_INFINITY), null);
});

test("legacy Redis messages still parse but legacy assistants are not reused", async () => {
	const [{ authorizeHistory }, { SessionMemoryMessageSchema }] = await modules;
	const messages = [
		SessionMemoryMessageSchema.parse({ role: "user", content: "old question" }),
		SessionMemoryMessageSchema.parse({
			role: "assistant",
			content: "old answer",
		}),
	];
	const access = authorizer();
	assert.deepEqual(
		await authorizeHistory({
			messages,
			identity,
			libraryId,
			citationAuthorizer: access.value,
		}),
		{
			messages: [],
			sourceReferences: [],
		},
	);
	assert.equal(access.calls.length, 0);
	assert.deepEqual(
		SessionMemoryMessageSchema.parse(exchange()[1]),
		exchange()[1],
	);
});

test("malformed raw Redis rows invalidate the window rather than bridge exchanges", async () => {
	const [{ authorizeHistory }, { parseSessionMemoryMessages }] = await modules;
	const [user, assistant] = exchange();
	for (const invalid of [
		"not JSON",
		JSON.stringify({ role: "user", content: 123 }),
		JSON.stringify({
			role: "assistant",
			content: "broken",
			provenance: { ...provenance(), version: 2 },
		}),
		JSON.stringify({
			role: "assistant",
			content: "broken",
			provenance: {
				...provenance(),
				sourceReferences: [{ doc_id: "missing-version" }],
			},
		}),
	]) {
		const parsed = parseSessionMemoryMessages([
			JSON.stringify(user),
			invalid,
			JSON.stringify(assistant),
		]);
		assert.deepEqual(parsed, []);
		assert.deepEqual(
			await authorizeHistory({
				messages: parsed,
				identity,
				libraryId,
				citationAuthorizer: authorizer().value,
			}),
			{
				messages: [],
				sourceReferences: [],
			},
		);
	}
	assert.deepEqual(
		parseSessionMemoryMessages(
			exchange().map((message) => JSON.stringify(message)),
		),
		exchange(),
	);
});

test("authorized history returns whole exchanges and only metadata dependencies", async () => {
	const [{ authorizeHistory }] = await modules;
	const access = authorizer();
	const result = await authorizeHistory({
		messages: [
			...exchange(),
			...exchange(
				provenance([reference(), reference("b")]),
				"follow up",
				"new answer",
			),
		],
		identity,
		libraryId,
		citationAuthorizer: access.value,
	});
	assert.deepEqual(result, {
		messages: [
			{ role: "user", content: "question" },
			{ role: "assistant", content: "answer" },
			{ role: "user", content: "follow up" },
			{ role: "assistant", content: "new answer" },
		],
		sourceReferences: [reference(), reference("b")],
	});
	assert.equal(access.calls.length, 1);
	assert.equal(access.calls[0]?.identity, identity);
	assert.equal(access.calls[0]?.libraryId, libraryId);
	assert.equal(JSON.stringify(access.calls).includes("new answer"), false);
});

test("one revoked source drops the entire exchange, not just its citations", async () => {
	const [{ authorizeHistory }] = await modules;
	const access = authorizer(["document-a"]);
	const result = await authorizeHistory({
		messages: [
			...exchange(
				provenance([reference(), reference("b")]),
				"revoked question",
				"sensitive answer",
			),
			...exchange(
				provenance([reference("c")]),
				"independent question",
				"independent answer",
			),
		],
		identity,
		libraryId,
		citationAuthorizer: access.value,
	});
	assert.deepEqual(result, {
		messages: [
			{ role: "user", content: "independent question" },
			{ role: "assistant", content: "independent answer" },
		],
		sourceReferences: [reference("c")],
	});
});

test("truncated Redis history cannot forget a revoked earlier dependency", async () => {
	const [{ authorizeHistory, createMemoryProvenance }] = await modules;
	const first = await authorizeHistory({
		messages: exchange(),
		identity,
		libraryId,
		citationAuthorizer: authorizer().value,
	});
	const next = createMemoryProvenance(libraryId, [
		...first.sourceReferences,
		reference("b"),
	]);
	assert.ok(next);
	const truncated = exchange(next, "continue", "derived answer");
	const access = authorizer(["document-a"]);
	assert.deepEqual(
		await authorizeHistory({
			messages: truncated,
			identity,
			libraryId,
			citationAuthorizer: access.value,
		}),
		{
			messages: [],
			sourceReferences: [],
		},
	);
	assert.deepEqual(access.calls[0]?.citations, [reference(), reference("b")]);
});

test("cross-library and cross-scope lineage is excluded before authorization", async () => {
	const [{ authorizeHistory }] = await modules;
	const access = authorizer();
	const markers = [
		{ ...provenance(), libraryId: "library-b" },
		provenance([{ ...reference(), library_id: "library-b" }]),
		provenance([{ ...reference(), tenant_id: "organization-b" }]),
		provenance([{ ...reference(), workspace_id: "workspace-b" }]),
	];
	for (const marker of markers) {
		assert.deepEqual(
			await authorizeHistory({
				messages: exchange(marker),
				identity,
				libraryId,
				citationAuthorizer: access.value,
			}),
			{
				messages: [],
				sourceReferences: [],
			},
		);
	}
	assert.equal(access.calls.length, 0);
	assert.deepEqual(
		await authorizeHistory({
			messages: [...exchange(markers[0]), ...exchange()],
			identity,
			libraryId,
			citationAuthorizer: access.value,
		}),
		{
			messages: [
				{ role: "user", content: "question" },
				{ role: "assistant", content: "answer" },
			],
			sourceReferences: [reference()],
		},
	);
});

test("missing, malformed, empty and unknown-version provenance is never reusable", async () => {
	const [{ authorizeHistory }] = await modules;
	const access = authorizer();
	for (const marker of [
		undefined,
		{ ...provenance(), version: 2 },
		provenance([]),
		{ ...provenance(), sourceReferences: [reference(), { doc_id: "missing" }] },
		{
			...provenance(),
			sourceReferences: [{ ...reference(), body: "not metadata" }],
		},
	]) {
		const messages = [
			{ role: "user", content: "old question" },
			{ role: "assistant", content: "unsafe", provenance: marker },
		] as SessionMemoryMessage[];
		assert.deepEqual(
			await authorizeHistory({
				messages,
				identity,
				libraryId,
				citationAuthorizer: access.value,
			}),
			{
				messages: [],
				sourceReferences: [],
			},
		);
	}
	assert.equal(access.calls.length, 0);
});

test("archived history requires complete adjacent exchanges and a direct server marker", async () => {
	const [{ authorizeArchivedHistory }] = await modules;
	const user = { role: "user", content: "question", status: "complete" };
	const assistant = {
		role: "assistant",
		content: "answer",
		status: "complete",
		debug: { memory_provenance: provenance() },
	};
	for (const turns of [
		[{ ...user, status: "failed" }, assistant],
		[user, { ...assistant, status: "pending" }],
		[user, { role: "tool", content: "tool", status: "complete" }, assistant],
		[assistant],
		[user],
		[
			user,
			{
				...assistant,
				debug: { retrieval_debug: { memory_provenance: provenance() } },
			},
		],
		[user, { ...assistant, debug: null }],
	]) {
		assert.deepEqual(
			await authorizeArchivedHistory({
				turns,
				identity,
				libraryId,
				citationAuthorizer: authorizer().value,
			}),
			{
				messages: [],
				sourceReferences: [],
			},
		);
	}
	assert.deepEqual(
		await authorizeArchivedHistory({
			turns: [user, assistant],
			identity,
			libraryId,
			citationAuthorizer: authorizer().value,
		}),
		{
			messages: [
				{ role: "user", content: "question" },
				{ role: "assistant", content: "answer" },
			],
			sourceReferences: [reference()],
		},
	);
});

test("authorization failures propagate and duplicate allowances cannot hide a missing source", async () => {
	const [{ authorizeHistory }] = await modules;
	const input = {
		messages: exchange(provenance([reference(), reference("b")])),
		identity,
		libraryId,
	};
	await assert.rejects(
		authorizeHistory({
			...input,
			citationAuthorizer: {
				async filterAuthorized() {
					throw new Error("backend unavailable");
				},
			},
		}),
		/backend unavailable/,
	);
	assert.deepEqual(
		await authorizeHistory({
			...input,
			citationAuthorizer: {
				async filterAuthorized() {
					return [reference(), reference()];
				},
			},
		}),
		{
			messages: [],
			sourceReferences: [],
		},
	);
	await assert.rejects(
		authorizeHistory({
			...input,
			citationAuthorizer: {
				async filterAuthorized() {
					return [{ doc_id: "incomplete" }];
				},
			},
		}),
		/invalid source references/,
	);
});

test("a dependency budget keeps recent whole exchanges without trimming their lineage", async () => {
	const [{ authorizeHistory }] = await modules;
	const earlier = Array.from({ length: 160 }, (_, index) =>
		reference(`earlier-${index}`),
	);
	const later = Array.from({ length: 160 }, (_, index) =>
		reference(`later-${index}`),
	);
	const result = await authorizeHistory({
		messages: [
			...exchange(provenance(earlier), "earlier question", "earlier answer"),
			...exchange(provenance(later), "later question", "later answer"),
		],
		identity,
		libraryId,
		citationAuthorizer: authorizer().value,
	});
	assert.deepEqual(result, {
		messages: [
			{ role: "user", content: "later question" },
			{ role: "assistant", content: "later answer" },
		],
		sourceReferences: later,
	});
});
