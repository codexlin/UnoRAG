import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "redis";

import {
	toApiCitation,
	toUiCitation,
} from "../../src/components/app/ask-turn-state";
import * as schema from "../../src/db/schema";
import type { AuthIdentity } from "../../src/lib/server/auth/provider";
import type { MemoryProvenance } from "../../src/server/conversations/memory-provenance";
import { ConversationRepository } from "../../src/server/conversations/repository";
import type { ConversationScope } from "../../src/server/conversations/types";
import { closeGlobalDatabasePool } from "../helpers/runtime";

const databaseUrl = process.env.INTEGRATION_DATABASE_URL?.trim();
const redisUrl = process.env.REDIS_INTEGRATION_TEST_URL?.trim();
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
	import("../../src/server/http/ask/conversation-handler"),
	import("../../src/server/http/ask/authorization-checkpoint"),
	import("../../src/server/conversations/session-memory"),
	import("../../src/lib/server/integration-rag"),
	import("../../src/lib/server/service-keys"),
	import("../../src/server/http/ask/native-handler"),
	import("../../src/app/api/v1/ask/route"),
]).finally(() => {
	nodeModule._resolveFilename = originalResolveFilename;
});

async function withFixture(
	run: (fixture: Awaited<ReturnType<typeof seedFixture>>) => Promise<void>,
) {
	assert.ok(databaseUrl);
	const pool = new Pool({ connectionString: databaseUrl, max: 2 });
	const db = drizzle(pool, { schema });
	const organizationId = randomUUID();
	try {
		await run(await seedFixture(db, organizationId));
	} finally {
		try {
			await db
				.delete(schema.conversationThreads)
				.where(eq(schema.conversationThreads.organizationId, organizationId));
			const documents = await db
				.select({ id: schema.documents.id })
				.from(schema.documents)
				.where(eq(schema.documents.organizationId, organizationId));
			if (documents.length > 0) {
				await db.delete(schema.documentActiveVersions).where(
					inArray(
						schema.documentActiveVersions.documentId,
						documents.map((document) => document.id),
					),
				);
			}
			await db
				.delete(schema.organizations)
				.where(eq(schema.organizations.id, organizationId));
		} finally {
			await pool.end();
		}
	}
}

async function seedFixture(
	db: ReturnType<typeof drizzle<typeof schema>>,
	organizationId: string,
) {
	const workspaceId = randomUUID();
	const principalId = randomUUID();
	const otherPrincipalId = randomUUID();
	const libraryUuid = randomUUID();
	const suffix = organizationId.slice(0, 8);
	const libraryId = `ask-auth-${organizationId}`;
	await db.insert(schema.organizations).values({
		id: organizationId,
		slug: `ask-auth-${organizationId}`,
		name: "Ask authorization test",
	});
	await db.insert(schema.workspaces).values({
		id: workspaceId,
		organizationId,
		slug: "ask-auth",
		name: "Ask authorization test",
	});
	await db.insert(schema.users).values(
		[principalId, otherPrincipalId].map((id) => ({
			id,
			organizationId,
			externalSubject: `ask-auth-${id}`,
			displayName: "Ask test principal",
		})),
	);
	await db
		.insert(schema.workspaceMembers)
		.values({ workspaceId, userId: principalId, role: "viewer" });
	await db.insert(schema.libraries).values({
		id: libraryUuid,
		organizationId,
		workspaceId,
		ragLibraryId: libraryId,
		name: "Ask authorization test",
		status: "ready",
	});
	const sources: Array<{
		documentId: string;
		reference: MemoryProvenance["sourceReferences"][number];
	}> = [];
	for (const label of ["a", "b"]) {
		const documentId = randomUUID();
		const versionId = randomUUID();
		const generationId = randomUUID();
		const ragDocumentId = `ask-auth-${suffix}-${label}`;
		await db.insert(schema.documents).values({
			id: documentId,
			organizationId,
			workspaceId,
			libraryId: libraryUuid,
			ragDocumentId,
			name: `Source ${label}`,
			filename: `${label}.txt`,
			contentType: "text/plain",
			status: "ready",
		});
		await db.insert(schema.documentVersions).values({
			id: versionId,
			documentId,
			version: 1,
			generationId,
			contentHash: "a".repeat(64),
			storageKey: `ask-auth/${organizationId}/${label}.txt`,
			status: "active",
		});
		await db
			.insert(schema.documentActiveVersions)
			.values({ documentId, versionId });
		await db.insert(schema.documentAcl).values({
			documentId,
			subjectType: "principal",
			subjectId: principalId,
			permission: "read",
		});
		sources.push({
			documentId,
			reference: {
				doc_id: ragDocumentId,
				document_version_id: versionId,
				generation_id: generationId,
				tenant_id: organizationId,
				workspace_id: workspaceId,
				library_id: libraryId,
			},
		});
	}
	const identity: AuthIdentity = {
		tenantId: organizationId,
		workspaceId,
		workspaceName: "Ask authorization test",
		principalId,
		groupIds: [],
		organizationRole: "member",
		role: "viewer",
		email: null,
		displayName: "Ask test principal",
		provider: "local",
		mustChangePassword: false,
	};
	const scope: ConversationScope = { organizationId, workspaceId, principalId };
	const [, { DrizzleHistoricalCitationAuthorizer }] = await modules;
	return {
		db,
		identity,
		scope,
		libraryId,
		sources,
		repository: new ConversationRepository(db),
		citationAuthorizer: new DrizzleHistoricalCitationAuthorizer(db),
		async revokeFirstSource() {
			// Removing every ACL row would make the document workspace-visible.
			await db
				.update(schema.documentAcl)
				.set({ subjectId: otherPrincipalId })
				.where(
					and(
						eq(schema.documentAcl.documentId, sources[0].documentId),
						eq(schema.documentAcl.subjectId, principalId),
					),
				);
		},
	};
}

test("real PostgreSQL citation authorization observes committed ACL and active-version changes", {
	skip: databaseUrl ? false : "INTEGRATION_DATABASE_URL is required",
}, async () => {
	await withFixture(async (fixture) => {
		const { identity, libraryId, citationAuthorizer, sources, db } = fixture;
		const citations = sources.map((source) => source.reference);
		assert.deepEqual(
			await citationAuthorizer.filterAuthorized({
				identity,
				libraryId,
				citations,
			}),
			citations,
		);
		await fixture.revokeFirstSource();
		assert.deepEqual(
			await citationAuthorizer.filterAuthorized({
				identity,
				libraryId,
				citations,
			}),
			[citations[1]],
		);
		const nextVersionId = randomUUID();
		await db.insert(schema.documentVersions).values({
			id: nextVersionId,
			documentId: sources[1].documentId,
			version: 2,
			generationId: randomUUID(),
			contentHash: "b".repeat(64),
			storageKey: `ask-auth/${identity.tenantId}/replacement.txt`,
			status: "active",
		});
		await db
			.update(schema.documentActiveVersions)
			.set({ versionId: nextVersionId })
			.where(
				eq(schema.documentActiveVersions.documentId, sources[1].documentId),
			);
		assert.deepEqual(
			await citationAuthorizer.filterAuthorized({
				identity,
				libraryId,
				citations: [citations[1]],
			}),
			[],
		);
	});
});

test("real PostgreSQL checkpoints enforce forced checks and explicitly bounded cached checks", {
	skip: databaseUrl ? false : "INTEGRATION_DATABASE_URL is required",
}, async () => {
	const [, , { AskAuthorizationCheckpoint, AskAccessRevokedError }] =
		await modules;
	await withFixture(async (fixture) => {
		let now = 0;
		let current: AuthIdentity | null = fixture.identity;
		const checkpoint = new AskAuthorizationCheckpoint(
			fixture.identity,
			fixture.libraryId,
			{
				refreshIdentity: async () => current,
				citationAuthorizer: fixture.citationAuthorizer,
				resolveLibrary: async (identity, libraryId) => {
					const [library] = await fixture.db
						.select()
						.from(schema.libraries)
						.where(
							and(
								eq(schema.libraries.organizationId, identity.tenantId),
								eq(schema.libraries.workspaceId, identity.workspaceId),
								eq(schema.libraries.ragLibraryId, libraryId),
							),
						)
						.limit(1);
					return library ?? null;
				},
			},
			() => now,
		);
		const citations = fixture.sources.map((source) => source.reference);
		await checkpoint.check(citations, { force: true });
		await fixture.revokeFirstSource();
		now = 500;
		await assert.doesNotReject(checkpoint.check(citations));
		await assert.rejects(
			checkpoint.check(citations, { force: true }),
			AskAccessRevokedError,
		);
		now = 1_000;
		await assert.rejects(checkpoint.check(citations), AskAccessRevokedError);
		await assert.rejects(
			checkpoint.check([{ ...citations[1], generation_id: undefined }], {
				force: true,
			}),
			AskAccessRevokedError,
		);
		current = null;
		await assert.rejects(
			checkpoint.check([citations[1]], { force: true }),
			AskAccessRevokedError,
		);
	});
});

test("running Ask pins admitted generations but publication never bypasses live ACL or deletion", {
	skip: databaseUrl ? false : "INTEGRATION_DATABASE_URL is required",
}, async () => {
	const [
		{ authorizeHistory, createMemoryProvenance },
		,
		{ AskAuthorizationCheckpoint, AskAccessRevokedError },
	] = await modules;
	await withFixture(async (fixture) => {
		const { db, identity, libraryId, sources, citationAuthorizer } = fixture;
		const source = sources[0];
		const dependencies = {
			refreshIdentity: async () => identity,
			resolveLibrary: (async () => ({ id: libraryId })) as never,
			citationAuthorizer,
		};
		const running = new AskAuthorizationCheckpoint(
			identity,
			libraryId,
			dependencies,
		);
		await running.check([source.reference], { force: true });
		const next = {
			...source.reference,
			document_version_id: randomUUID(),
			generation_id: randomUUID(),
		};
		await db.transaction(async (tx) => {
			await tx
				.update(schema.documentVersions)
				.set({ status: "superseded", supersededAt: new Date() })
				.where(
					eq(schema.documentVersions.id, source.reference.document_version_id),
				);
			await tx.insert(schema.documentVersions).values({
				id: next.document_version_id,
				documentId: source.documentId,
				version: 2,
				generationId: next.generation_id,
				contentHash: "c".repeat(64),
				storageKey: `ask-auth/${identity.tenantId}/v2.txt`,
				status: "active",
			});
			await tx
				.update(schema.documentActiveVersions)
				.set({ versionId: next.document_version_id })
				.where(eq(schema.documentActiveVersions.documentId, source.documentId));
		});
		await running.check([source.reference], { force: true });
		const fresh = new AskAuthorizationCheckpoint(
			identity,
			libraryId,
			dependencies,
		);
		await assert.rejects(
			fresh.check([source.reference]),
			AskAccessRevokedError,
		);
		await fresh.check([next], { force: true });
		const history = await authorizeHistory({
			identity,
			libraryId,
			citationAuthorizer,
			messages: [
				{ role: "user", content: "old question" },
				{
					role: "assistant",
					content: "old answer",
					provenance:
						createMemoryProvenance(libraryId, [source.reference]) ?? undefined,
				},
			],
		});
		assert.deepEqual(history.messages, []);
		for (const status of ["failed", "cancelled", "deleting", "deleted"]) {
			await db
				.update(schema.documentVersions)
				.set({ status })
				.where(
					eq(schema.documentVersions.id, source.reference.document_version_id),
				);
			await assert.rejects(
				running.check([source.reference], { force: true }),
				AskAccessRevokedError,
			);
		}
		await db
			.update(schema.documentVersions)
			.set({ status: "superseded" })
			.where(
				eq(schema.documentVersions.id, source.reference.document_version_id),
			);
		await fixture.revokeFirstSource();
		await assert.rejects(
			running.check([source.reference], { force: true }),
			AskAccessRevokedError,
		);
		await db
			.delete(schema.documentAcl)
			.where(eq(schema.documentAcl.documentId, source.documentId));
		await running.check([source.reference], { force: true });
		await db
			.update(schema.documents)
			.set({ status: "deleting", deletedAt: new Date() })
			.where(eq(schema.documents.id, source.documentId));
		await assert.rejects(
			running.check([source.reference], { force: true }),
			AskAccessRevokedError,
		);
	});
});

test("temporary Ask to Redis to PostgreSQL archive preserves safe follow-up context", {
	skip:
		databaseUrl && redisUrl
			? false
			: "INTEGRATION_DATABASE_URL and REDIS_INTEGRATION_TEST_URL are required",
}, async () => {
	const [
		,
		{ handleNativeConversationRequest },
		,
		memory,
		,
		,
		{ handleNativeAskRequest },
	] = await modules;
	const previousRedisUrl = process.env.REDIS_URL;
	process.env.REDIS_URL = redisUrl;
	try {
		await withFixture(async (fixture) => {
			const { identity, libraryId, repository, citationAuthorizer } = fixture;
			const memoryStore = new memory.RedisSessionMemoryStore();
			const authorization = {
				refreshIdentity: async () => identity,
				resolveLibrary: (async () => ({ id: libraryId })) as never,
				citationAuthorizer,
			};
			let observedHistory: unknown;
			const sessionId = randomUUID();
			const question = "Who owns the rollout?";
			const answer = "Alice owns the rollout.";
			const runtimeFactory = (() => ({
				async invoke(input: { history: unknown }) {
					observedHistory = input.history;
					return {
						session_id: sessionId,
						question,
						library_id: libraryId,
						history: input.history,
						citations: [fixture.sources[0].reference],
						refused: false,
						retrieval_attempts: 1,
					};
				},
				async *streamAnswer() {
					yield answer;
				},
			})) as never;
			const ask = (body: Record<string, unknown>) =>
				handleNativeAskRequest({
					request: new Request("http://local/v1/ask", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							session_id: sessionId,
							library_id: libraryId,
							question,
							...body,
						}),
					}),
					path: ["v1", "ask"],
					identity,
					repository,
					memoryStore,
					authorization,
					runtimeFactory,
					askRunsRepository: null,
					observeMetrics: false,
				});
			const first = await ask({});
			assert.equal(first?.status, 200);
			const result = await first?.json();
			assert.equal(result.citations[0].generation_id, undefined);
			const archived = await handleNativeConversationRequest({
				request: new Request("http://local/v1/threads", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						session_id: sessionId,
						library_id: libraryId,
						turns: [
							{
								question,
								answer,
								citations: result.citations
									.map(toUiCitation)
									.map(toApiCitation),
							},
						],
					}),
				}),
				path: ["v1", "threads"],
				identity,
				repository,
				memoryStore,
				citationAuthorizer,
			});
			assert.equal(archived?.status, 200);
			const thread = await archived?.json();
			assert.equal(thread.turns[0].citations.length, 1);
			assert.equal(
				thread.turns[0].citations[0].document_version_id,
				fixture.sources[0].reference.document_version_id,
			);
			const stored = await repository.getThread(fixture.scope, thread.id);
			assert.ok(stored);
			assert.ok(stored.turns[1].debug?.memory_provenance);
			const second = await ask({
				thread_id: thread.id,
				question: "What does she own?",
			});
			assert.equal(second?.status, 200);
			assert.deepEqual(observedHistory, [
				{ role: "user", content: question },
				{ role: "assistant", content: answer },
			]);
			await fixture.revokeFirstSource();
			const blocked = await ask({
				thread_id: thread.id,
				question: "Repeat the previous answer",
			});
			assert.equal(blocked?.status, 403);
			assert.deepEqual(observedHistory, []);
		});
	} finally {
		await memory.closeSessionMemoryForTests();
		if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
		else process.env.REDIS_URL = previousRedisUrl;
	}
});

test("real PostgreSQL archived answers retain and reauthorize transitive memory sources", {
	skip: databaseUrl ? false : "INTEGRATION_DATABASE_URL is required",
}, async () => {
	const [{ authorizeArchivedHistory, createMemoryProvenance }] = await modules;
	await withFixture(async (fixture) => {
		const {
			identity,
			libraryId,
			citationAuthorizer,
			sources,
			repository,
			scope,
		} = fixture;
		const thread = await repository.createThread(scope, {
			ragLibraryId: libraryId,
		});
		const firstProvenance = createMemoryProvenance(libraryId, [
			sources[0].reference,
		]);
		assert.ok(firstProvenance);
		await repository.appendExchange(scope, thread.id, {
			user: { role: "user", content: "first question" },
			assistant: {
				role: "assistant",
				content: "first sensitive answer",
				citations: [sources[0].reference],
				debug: { memory_provenance: firstProvenance },
			},
		});
		const first = await repository.getThread(scope, thread.id);
		assert.ok(first);
		const selected = await authorizeArchivedHistory({
			turns: first.turns,
			identity,
			libraryId,
			citationAuthorizer,
		});
		assert.equal(selected.messages.length, 2);
		const nextProvenance = createMemoryProvenance(libraryId, [
			...selected.sourceReferences,
			sources[1].reference,
		]);
		assert.ok(nextProvenance);
		await repository.appendExchange(scope, thread.id, {
			user: { role: "user", content: "continue summarizing" },
			assistant: {
				role: "assistant",
				content: "answer derived from both sources",
				citations: [sources[1].reference],
				debug: { memory_provenance: nextProvenance },
			},
		});
		await repository.appendExchange(scope, thread.id, {
			user: { role: "user", content: "legacy imported question" },
			assistant: {
				role: "assistant",
				content: "unknown provenance",
				citations: [sources[1].reference],
			},
		});
		const saved = await repository.getThread(scope, thread.id);
		assert.ok(saved);
		const authorized = await authorizeArchivedHistory({
			turns: saved.turns,
			identity,
			libraryId,
			citationAuthorizer,
		});
		assert.equal(authorized.messages.length, 4);
		assert.deepEqual(
			authorized.sourceReferences,
			sources.map((source) => source.reference),
		);
		await fixture.revokeFirstSource();
		assert.deepEqual(
			await citationAuthorizer.filterAuthorized({
				identity,
				libraryId,
				citations: [sources[1].reference],
			}),
			[sources[1].reference],
		);
		assert.deepEqual(
			await authorizeArchivedHistory({
				turns: saved.turns,
				identity,
				libraryId,
				citationAuthorizer,
			}),
			{ messages: [], sourceReferences: [] },
		);
	});
});

test("real Redis truncation preserves transitive dependencies and rejects malformed pairing", {
	skip:
		databaseUrl && redisUrl
			? false
			: "INTEGRATION_DATABASE_URL and REDIS_INTEGRATION_TEST_URL are required",
}, async () => {
	assert.ok(redisUrl);
	const [{ authorizeHistory, createMemoryProvenance }, , , memory] =
		await modules;
	const previousRedisUrl = process.env.REDIS_URL;
	process.env.REDIS_URL = redisUrl;
	const inspector = createClient({ url: redisUrl });
	await inspector.connect();
	try {
		await withFixture(async (fixture) => {
			const { identity, libraryId, citationAuthorizer, sources, scope } =
				fixture;
			const sessionId = `ask-auth-${randomUUID()}`;
			const digest = createHash("sha256")
				.update(
					`${scope.organizationId}\0${scope.workspaceId}\0${scope.principalId}\0${sessionId}`,
				)
				.digest("hex");
			const key = `unorag:ask-memory:${digest}`;
			const store = new memory.RedisSessionMemoryStore();
			try {
				const marker = createMemoryProvenance(libraryId, [
					sources[0].reference,
				]);
				assert.ok(marker);
				await store.append(
					scope,
					sessionId,
					[
						{ role: "user", content: "first question" },
						{
							role: "assistant",
							content: "source A answer",
							provenance: marker,
						},
					],
					1,
				);
				const selected = await authorizeHistory({
					messages: await store.load(scope, sessionId, 1),
					identity,
					libraryId,
					citationAuthorizer,
				});
				assert.deepEqual(selected.sourceReferences, [sources[0].reference]);
				const combined = createMemoryProvenance(libraryId, [
					...selected.sourceReferences,
					sources[1].reference,
				]);
				assert.ok(combined);
				await store.append(
					scope,
					sessionId,
					[
						{ role: "user", content: "summarize both" },
						{
							role: "assistant",
							content: "combined answer",
							provenance: combined,
						},
					],
					1,
				);
				const truncated = await store.load(scope, sessionId, 1);
				assert.equal(truncated.length, 2);
				assert.equal(truncated[0]?.content, "summarize both");
				assert.deepEqual(
					truncated[1]?.provenance?.sourceReferences,
					sources.map((source) => source.reference),
				);
				assert.equal(
					(
						await authorizeHistory({
							messages: truncated,
							identity,
							libraryId,
							citationAuthorizer,
						})
					).messages.length,
					2,
				);
				assert.deepEqual(
					await authorizeHistory({
						messages: truncated,
						identity,
						libraryId: `${libraryId}-other`,
						citationAuthorizer,
					}),
					{ messages: [], sourceReferences: [] },
				);
				await fixture.revokeFirstSource();
				assert.deepEqual(
					await authorizeHistory({
						messages: truncated,
						identity,
						libraryId,
						citationAuthorizer,
					}),
					{ messages: [], sourceReferences: [] },
				);
				await inspector.del(key);
				await inspector.rPush(key, [
					JSON.stringify(truncated[0]),
					"malformed row between turns",
					JSON.stringify(truncated[1]),
				]);
				assert.deepEqual(await store.load(scope, sessionId, 2), []);
			} finally {
				await inspector.del(key);
			}
		});
	} finally {
		await memory.closeSessionMemoryForTests();
		await inspector.close();
		if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
		else process.env.REDIS_URL = previousRedisUrl;
	}
});

test("public Ask denies foreign-workspace and missing libraries with an unrestricted service key", {
	skip: databaseUrl ? false : "INTEGRATION_DATABASE_URL is required",
}, async () => {
	assert.ok(databaseUrl);
	const [, , , , , serviceKeys, , publicAskRoute] = await modules;
	const previousDatabaseUrl = process.env.DATABASE_URL;
	const previousRateLimit = process.env.UNORAG_PUBLIC_API_RATE_LIMIT_PER_MINUTE;
	process.env.DATABASE_URL = databaseUrl;
	process.env.UNORAG_PUBLIC_API_RATE_LIMIT_PER_MINUTE = "0";
	try {
		await withFixture(async (fixture) => {
			try {
				const foreignWorkspaceId = randomUUID();
				const foreignLibraryId = `foreign-${randomUUID()}`;
				await fixture.db.insert(schema.workspaces).values({
					id: foreignWorkspaceId,
					organizationId: fixture.identity.tenantId,
					slug: "foreign-workspace",
					name: "Foreign workspace secret",
				});
				await fixture.db.insert(schema.libraries).values({
					organizationId: fixture.identity.tenantId,
					workspaceId: foreignWorkspaceId,
					ragLibraryId: foreignLibraryId,
					name: "Foreign library secret",
					status: "ready",
				});
				const { rawKey, prefix } = serviceKeys.generateServiceKeyRaw();
				await fixture.db.insert(schema.workspaceServiceKeys).values({
					organizationId: fixture.identity.tenantId,
					workspaceId: fixture.identity.workspaceId,
					name: "Workspace-wide Ask key",
					prefix,
					keyHash: serviceKeys.hashServiceKey(rawKey),
					scopes: ["ask"],
					libraryIds: null,
				});
				const key = await serviceKeys.authenticateServiceKey(rawKey);
				assert.ok(key);
				assert.equal(key.libraryIds, null);
				assert.equal(
					serviceKeys.serviceKeyAllowsLibrary(key, foreignLibraryId),
					true,
				);

				for (const libraryId of [foreignLibraryId, `missing-${randomUUID()}`]) {
					const response = await publicAskRoute.POST(
						new Request("http://local/api/v1/ask", {
							method: "POST",
							headers: {
								"content-type": "application/json",
								authorization: `Bearer ${rawKey}`,
							},
							body: JSON.stringify({
								question: "Show the foreign content",
								library_id: libraryId,
							}),
						}),
					);
					assert.equal(response.status, 403);
					const requestId = response.headers.get("x-request-id");
					assert.ok(requestId);
					assert.equal(response.headers.get("x-unorag-api-version"), "1");
					assert.equal(response.headers.get("cache-control"), "no-store");
					assert.deepEqual(await response.json(), {
						error: {
							code: "library_access_denied",
							message: "library_id not allowed for this service key",
							request_id: requestId,
							retryable: false,
						},
					});
				}
			} finally {
				await closeGlobalDatabasePool();
			}
		});
	} finally {
		if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = previousDatabaseUrl;
		if (previousRateLimit === undefined)
			delete process.env.UNORAG_PUBLIC_API_RATE_LIMIT_PER_MINUTE;
		else
			process.env.UNORAG_PUBLIC_API_RATE_LIMIT_PER_MINUTE = previousRateLimit;
	}
});

test("public Ask refresh reauthenticates the original bearer against current PostgreSQL key permissions", {
	skip: databaseUrl ? false : "INTEGRATION_DATABASE_URL is required",
}, async () => {
	assert.ok(databaseUrl);
	const [, , , , { forwardIntegrationRag }, serviceKeys] = await modules;
	const previousDatabaseUrl = process.env.DATABASE_URL;
	process.env.DATABASE_URL = databaseUrl;
	try {
		await withFixture(async (fixture) => {
			try {
				const { rawKey, prefix } = serviceKeys.generateServiceKeyRaw();
				const keyId = randomUUID();
				await fixture.db.insert(schema.workspaceServiceKeys).values({
					id: keyId,
					organizationId: fixture.identity.tenantId,
					workspaceId: fixture.identity.workspaceId,
					name: "Original Ask key",
					prefix,
					keyHash: serviceKeys.hashServiceKey(rawKey),
					scopes: ["ask", "retrieve"],
					libraryIds: [fixture.libraryId],
				});
				const key = await serviceKeys.authenticateServiceKey(rawKey);
				assert.ok(key);
				const originalRequest = new Request("http://local/api/v1/ask", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${rawKey}`,
					},
					body: JSON.stringify({
						question: "Check the current integration identity",
						library_id: fixture.libraryId,
						session_id: `ask-key-${keyId}`,
					}),
				});
				const refreshCallbacks: Array<() => Promise<AuthIdentity | null>> = [];
				const nativeRequests: Request[] = [];
				const nativeIdentities: AuthIdentity[] = [];
				const response = await forwardIntegrationRag({
					request: originalRequest,
					key,
					target: "/v1/ask",
					requestId: randomUUID(),
					askHandler: async (input) => {
						nativeRequests.push(input.request);
						nativeIdentities.push(input.identity);
						if (input.refreshIdentity)
							refreshCallbacks.push(input.refreshIdentity);
						return Response.json({
							session_id: `ask-key-${keyId}`,
							question: "Check the current integration identity",
							answer: "Injected handler; no model called",
							citations: [],
							refused: false,
							refuse_reason: null,
							retrieval_mode: "dense",
						});
					},
				});
				assert.equal(response.status, 200);
				assert.equal(nativeRequests.length, 1);
				assert.notEqual(nativeRequests[0], originalRequest);
				assert.equal(nativeRequests[0].headers.get("authorization"), null);
				assert.equal(
					nativeRequests[0].headers.get("x-unorag-service-key"),
					null,
				);
				assert.equal(
					originalRequest.headers.get("authorization"),
					`Bearer ${rawKey}`,
				);
				assert.deepEqual(nativeIdentities, [
					serviceKeys.serviceKeyToIdentity(key),
				]);
				assert.equal(refreshCallbacks.length, 1);
				const refresh = refreshCallbacks[0];
				assert.deepEqual(
					await refresh(),
					serviceKeys.serviceKeyToIdentity(key),
				);

				await fixture.db
					.update(schema.workspaceServiceKeys)
					.set({ name: "Current Ask key" })
					.where(eq(schema.workspaceServiceKeys.id, keyId));
				const currentIdentity = {
					...serviceKeys.serviceKeyToIdentity(key),
					displayName: "Current Ask key",
				};
				assert.deepEqual(await refresh(), currentIdentity);

				await fixture.db
					.update(schema.workspaceServiceKeys)
					.set({ scopes: ["retrieve"] })
					.where(eq(schema.workspaceServiceKeys.id, keyId));
				assert.equal(await refresh(), null);
				await fixture.db
					.update(schema.workspaceServiceKeys)
					.set({ scopes: ["ask", "retrieve"] })
					.where(eq(schema.workspaceServiceKeys.id, keyId));
				assert.deepEqual(await refresh(), currentIdentity);

				await fixture.db
					.update(schema.workspaceServiceKeys)
					.set({ libraryIds: [`${fixture.libraryId}-other`] })
					.where(eq(schema.workspaceServiceKeys.id, keyId));
				assert.equal(await refresh(), null);
				await fixture.db
					.update(schema.workspaceServiceKeys)
					.set({ libraryIds: [fixture.libraryId] })
					.where(eq(schema.workspaceServiceKeys.id, keyId));
				assert.deepEqual(await refresh(), currentIdentity);

				await fixture.db
					.update(schema.workspaceServiceKeys)
					.set({ revokedAt: new Date() })
					.where(eq(schema.workspaceServiceKeys.id, keyId));
				assert.equal(await refresh(), null);
			} finally {
				// Drain the gateway's asynchronous audit and last-used writes before cleanup.
				await closeGlobalDatabasePool();
			}
		});
	} finally {
		if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = previousDatabaseUrl;
	}
});
