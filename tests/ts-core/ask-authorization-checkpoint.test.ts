import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { AuthIdentity } from "../../src/lib/server/auth/provider";

const require = createRequire(import.meta.url);
const nodeModule = require("node:module");
const originalResolve = nodeModule._resolveFilename;
nodeModule._resolveFilename = (name: string, ...args: unknown[]) =>
	name === "server-only"
		? require.resolve("next/package.json")
		: originalResolve.call(nodeModule, name, ...args);
const checkpointModule = import(
	"../../src/server/http/ask/authorization-checkpoint"
).finally(() => {
	nodeModule._resolveFilename = originalResolve;
});

const identity: AuthIdentity = {
	tenantId: "org",
	workspaceId: "workspace",
	workspaceName: "Workspace",
	principalId: "reader",
	groupIds: ["hr"],
	organizationRole: "member",
	role: "viewer",
	email: null,
	displayName: "Reader",
	provider: "local",
	mustChangePassword: false,
};
const evidence = [
	{ doc_id: "doc", document_version_id: "v1", generation_id: "g1" },
];

async function fixture() {
	const { AskAuthorizationCheckpoint, AskAccessRevokedError } =
		await checkpointModule;
	let current: AuthIdentity | null = identity;
	let allowed = true;
	let libraryAllowed = true;
	let now = 0;
	let refreshes = 0;
	const guard = new AskAuthorizationCheckpoint(
		identity,
		"library",
		{
			refreshIdentity: async () => {
				refreshes++;
				return current;
			},
			resolveLibrary: (async () =>
				libraryAllowed ? { id: "library" } : null) as never,
			citationAuthorizer: {
				filterAuthorized: async ({ citations }) => (allowed ? citations : []),
			},
		},
		() => now,
	);
	return {
		guard,
		AskAccessRevokedError,
		setIdentity: (value: AuthIdentity | null) => {
			current = value;
		},
		setAllowed: (value: boolean) => {
			allowed = value;
		},
		setLibraryAllowed: (value: boolean) => {
			libraryAllowed = value;
		},
		advance: (ms: number) => {
			now += ms;
		},
		refreshes: () => refreshes,
	};
}

test("authorization is rechecked on forced boundaries and at the stream interval", async () => {
	const f = await fixture();
	await f.guard.check(evidence);
	await f.guard.check(evidence);
	assert.equal(f.refreshes(), 1);
	f.advance(1_000);
	await f.guard.check(evidence);
	assert.equal(f.refreshes(), 2);
	await f.guard.check(evidence, { force: true });
	assert.equal(f.refreshes(), 3);
});

test("revoking a session prevents later model or output checkpoints", async () => {
	const f = await fixture();
	await f.guard.check(evidence);
	f.setIdentity(null);
	await assert.rejects(
		f.guard.check(evidence, { force: true }),
		f.AskAccessRevokedError,
	);
});

test("group, workspace, role and required password changes invalidate the captured scope", async () => {
	for (const patch of [
		{ groupIds: [] },
		{ workspaceId: "foreign" },
		{ role: "editor" },
		{ principalId: "other" },
		{ mustChangePassword: true },
	]) {
		const f = await fixture();
		f.setIdentity({ ...identity, ...patch });
		await assert.rejects(f.guard.check(evidence), f.AskAccessRevokedError);
	}
});

test("library deletion or revoked evidence fails closed even with the same identity", async () => {
	for (const kind of ["library", "evidence"]) {
		const f = await fixture();
		await f.guard.check(evidence);
		if (kind === "library") f.setLibraryAllowed(false);
		else f.setAllowed(false);
		f.advance(1_000);
		await assert.rejects(f.guard.check(evidence), f.AskAccessRevokedError);
	}
});

test("a changed evidence set cannot reuse a recently authorized checkpoint", async () => {
	const f = await fixture();
	await f.guard.check(evidence);
	f.setAllowed(false);
	await assert.rejects(
		f.guard.check([
			...evidence,
			{ doc_id: "other", document_version_id: "v1" },
		]),
		f.AskAccessRevokedError,
	);
});

test("equivalent group order does not invalidate identity", async () => {
	const f = await fixture();
	f.setIdentity({ ...identity, groupIds: ["hr", "hr"] });
	await f.guard.check(evidence);
});

test("only evidence admitted while active may survive publication of its replacement", async () => {
	const { AskAuthorizationCheckpoint, AskAccessRevokedError } =
		await checkpointModule;
	let published = false;
	let revoked = false;
	const policies: string[] = [];
	const dependencies = {
		refreshIdentity: async () => identity,
		resolveLibrary: (async () => ({ id: "library" })) as never,
		citationAuthorizer: {
			async filterAuthorized(input: {
				citations: Record<string, unknown>[];
				versionPolicy?: string;
			}) {
				policies.push(input.versionPolicy ?? "active");
				return !revoked && (!published || input.versionPolicy === "retained")
					? input.citations
					: [];
			},
		},
	};
	const running = new AskAuthorizationCheckpoint(
		identity,
		"library",
		dependencies,
	);
	await running.check(evidence, { force: true });
	published = true;
	await running.check(evidence, { force: true });
	assert.deepEqual(policies, ["active", "retained"]);
	const fresh = new AskAuthorizationCheckpoint(
		identity,
		"library",
		dependencies,
	);
	await assert.rejects(fresh.check(evidence), AskAccessRevokedError);
	await assert.rejects(
		running.check(
			[
				...evidence,
				{ doc_id: "unseen", document_version_id: "v1", generation_id: "g1" },
			],
			{ force: true },
		),
		AskAccessRevokedError,
	);
	revoked = true;
	await assert.rejects(
		running.check(evidence, { force: true }),
		AskAccessRevokedError,
	);
});

test("current evidence authorization is independent from the smaller memory budget", async () => {
	const f = await fixture();
	const references = Array.from({ length: 300 }, (_, index) => ({
		doc_id: `doc-${index}`,
		document_version_id: "v1",
		generation_id: `g-${index}`,
	}));
	await f.guard.check(references);
	await assert.rejects(
		f.guard.check(
			Array.from({ length: 1_025 }, (_, index) => ({
				doc_id: `doc-${index}`,
				document_version_id: "v1",
				generation_id: `g-${index}`,
			})),
		),
		f.AskAccessRevokedError,
	);
});

test("authorization backend errors propagate rather than reuse stale authorization", async () => {
	const { AskAuthorizationCheckpoint } = await checkpointModule;
	const guard = new AskAuthorizationCheckpoint(identity, "library", {
		refreshIdentity: async () => {
			throw new Error("backend unavailable");
		},
		resolveLibrary: (async () => ({ id: "library" })) as never,
		citationAuthorizer: {
			filterAuthorized: async ({ citations }) => citations,
		},
	});
	await assert.rejects(guard.check(evidence), /backend unavailable/);
});
