import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "../src/db/schema";
import { ConversationRepository } from "../src/server/conversations/repository";

const databaseUrl = process.env.CONVERSATION_TEST_DATABASE_URL?.trim();
const enabled = Boolean(databaseUrl);
const ids = {
	organization: "10000000-0000-4000-8000-000000000001",
	workspaceA: "20000000-0000-4000-8000-000000000001",
	workspaceB: "20000000-0000-4000-8000-000000000002",
	principalA: "30000000-0000-4000-8000-000000000001",
	principalB: "30000000-0000-4000-8000-000000000002",
	libraryA: "40000000-0000-4000-8000-000000000001",
	libraryB: "40000000-0000-4000-8000-000000000002",
};

const pool = enabled ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;
const repository = db ? new ConversationRepository(db) : null;

const scopeA = {
	organizationId: ids.organization,
	workspaceId: ids.workspaceA,
	principalId: ids.principalA,
};

before(async () => {
	if (!db) return;
	await db.insert(schema.organizations).values({
		id: ids.organization,
		slug: "conversation-test",
		name: "Conversation Test",
	});
	await db.insert(schema.users).values([
		{
			id: ids.principalA,
			organizationId: ids.organization,
			externalSubject: "conversation-a",
			displayName: "Conversation A",
		},
		{
			id: ids.principalB,
			organizationId: ids.organization,
			externalSubject: "conversation-b",
			displayName: "Conversation B",
		},
	]);
	await db.insert(schema.workspaces).values([
		{
			id: ids.workspaceA,
			organizationId: ids.organization,
			slug: "conversation-a",
			name: "Conversation A",
		},
		{
			id: ids.workspaceB,
			organizationId: ids.organization,
			slug: "conversation-b",
			name: "Conversation B",
		},
	]);
	await db.insert(schema.workspaceMembers).values([
		{
			workspaceId: ids.workspaceA,
			userId: ids.principalA,
			role: "member",
		},
		{
			workspaceId: ids.workspaceA,
			userId: ids.principalB,
			role: "member",
		},
		{
			workspaceId: ids.workspaceB,
			userId: ids.principalA,
			role: "member",
		},
	]);
	await db.insert(schema.libraries).values([
		{
			id: ids.libraryA,
			organizationId: ids.organization,
			workspaceId: ids.workspaceA,
			ragLibraryId: "rag-conversation-a",
			name: "Conversation A",
		},
		{
			id: ids.libraryB,
			organizationId: ids.organization,
			workspaceId: ids.workspaceB,
			ragLibraryId: "rag-conversation-b",
			name: "Conversation B",
		},
	]);
});

after(async () => {
	if (!db || !pool) return;
	await db
		.delete(schema.organizations)
		.where(eq(schema.organizations.id, ids.organization));
	await pool.end();
});

test("scoped repository isolates threads and appends turns in stable order", {
	skip: !enabled,
}, async () => {
	assert.ok(repository);
	const thread = await repository.createThread(scopeA, {
		ragLibraryId: "rag-conversation-a",
		title: "Scoped conversation",
	});

	await Promise.all([
		repository.appendTurn(scopeA, thread.id, {
			role: "user",
			content: "question",
		}),
		repository.appendTurn(scopeA, thread.id, {
			role: "assistant",
			content: "answer",
			citations: [{ id: "citation-1" }],
			debug: { route: "fast" },
			usage: { totalTokens: 12 },
		}),
	]);

	const detail = await repository.getThread(scopeA, thread.id);
	assert.ok(detail);
	assert.deepEqual(
		detail.turns.map((turn) => turn.sequence),
		[1, 2],
	);
	assert.deepEqual(detail.turns.map((turn) => turn.content).sort(), [
		"answer",
		"question",
	]);

	assert.equal(
		await repository.getThread(
			{ ...scopeA, workspaceId: ids.workspaceB },
			thread.id,
		),
		null,
	);
	assert.equal(
		await repository.getThread(
			{ ...scopeA, principalId: ids.principalB },
			thread.id,
		),
		null,
	);
	assert.equal(
		(
			await repository.listThreads({
				...scopeA,
				workspaceId: ids.workspaceB,
			})
		).length,
		0,
	);
});

test("thread library foreign key rejects a library from another workspace", {
	skip: !enabled,
}, async () => {
	assert.ok(repository);
	await assert.rejects(
		repository.createThread(scopeA, {
			ragLibraryId: "rag-conversation-b",
		}),
	);
});

test("scoped repository supports server-side search, library filter, wildcard escaping, and keyset pagination", {
	skip: !enabled,
}, async () => {
	assert.ok(repository && db);
	const t1 = await repository.createThread(scopeA, {
		ragLibraryId: "rag-conversation-a",
		title: "Quarterly 100% revenue review",
	});
	const t2 = await repository.createThread(scopeA, {
		ragLibraryId: "rag-conversation-a",
		title: "Quarterly 1000 revenue review",
	});
	const t3 = await repository.createThread(scopeA, {
		ragLibraryId: null,
		title: "Quarterly unlinked notes",
	});
	const t4 = await repository.createThread(scopeA, {
		ragLibraryId: "rag-conversation-a",
		title: "Quarterly older archive item",
	});

	// Set deterministic ordering timestamps so keyset cursor order is exact.
	const stamps = [
		[t1.id, new Date("2026-06-04T00:00:00.000Z")],
		[t2.id, new Date("2026-06-03T00:00:00.000Z")],
		[t3.id, new Date("2026-06-02T00:00:00.000Z")],
		[t4.id, new Date("2026-06-01T00:00:00.000Z")],
	] as const;
	for (const [id, updatedAt] of stamps) {
		await db
			.update(schema.conversationThreads)
			.set({ updatedAt, createdAt: updatedAt })
			.where(eq(schema.conversationThreads.id, id));
	}

	// Wildcard '%' must match literally, not match '1000'.
	const literalPercent = await repository.listThreads(scopeA, {
		query: "100%",
		limit: 10,
	});
	assert.deepEqual(
		literalPercent.map((row) => row.id),
		[t1.id],
	);

	// Unlinked filter (libraryId: null) returns only unlinked threads.
	const unlinked = await repository.listThreads(scopeA, {
		query: "Quarterly",
		libraryId: null,
		limit: 10,
	});
	assert.deepEqual(
		unlinked.map((row) => row.id),
		[t3.id],
	);

	// Count + keyset pagination across all 4 matching threads in pages of 2.
	const total = await repository.countThreads(scopeA, { query: "Quarterly" });
	assert.equal(total, 4);

	const page1 = await repository.listThreads(scopeA, {
		query: "Quarterly",
		limit: 2,
	});
	assert.deepEqual(
		page1.map((row) => row.id),
		[t1.id, t2.id],
	);

	const last1 = page1[page1.length - 1];
	assert.ok(last1);
	const page2 = await repository.listThreads(scopeA, {
		query: "Quarterly",
		limit: 2,
		cursor: {
			updatedAt: last1.updatedAt,
			createdAt: last1.createdAt,
			id: last1.id,
		},
	});
	assert.deepEqual(
		page2.map((row) => row.id),
		[t3.id, t4.id],
	);

	const last2 = page2[page2.length - 1];
	assert.ok(last2);
	const page3 = await repository.listThreads(scopeA, {
		query: "Quarterly",
		limit: 2,
		cursor: {
			updatedAt: last2.updatedAt,
			createdAt: last2.createdAt,
			id: last2.id,
		},
	});
	assert.deepEqual(page3, []);
});
