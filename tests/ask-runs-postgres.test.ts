import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "../src/db/schema";
import { createAskRunsRepository } from "../src/server/observability/ask-runs-repository";

const databaseUrl = process.env.ASK_RUNS_TEST_DATABASE_URL?.trim();
const enabled = Boolean(databaseUrl);
const ids = {
	organization: "71000000-0000-4000-8000-000000000001",
	workspaceA: "72000000-0000-4000-8000-000000000001",
	workspaceB: "72000000-0000-4000-8000-000000000002",
	user: "73000000-0000-4000-8000-000000000001",
	libraryA: "74000000-0000-4000-8000-000000000001",
	libraryB: "74000000-0000-4000-8000-000000000002",
	serviceKey: "75000000-0000-4000-8000-000000000001",
	thread: "76000000-0000-4000-8000-000000000001",
};

const pool = enabled ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;
const repository = db ? createAskRunsRepository(db) : null;

before(async () => {
	if (!db) return;
	await db.insert(schema.organizations).values({
		id: ids.organization,
		slug: "ask-runs-test",
		name: "Ask Runs Test",
	});
	await db.insert(schema.users).values({
		id: ids.user,
		organizationId: ids.organization,
		externalSubject: "ask-runs-user",
		displayName: "Ask Runs User",
	});
	await db.insert(schema.workspaces).values([
		{
			id: ids.workspaceA,
			organizationId: ids.organization,
			slug: "ask-runs-a",
			name: "Ask Runs A",
		},
		{
			id: ids.workspaceB,
			organizationId: ids.organization,
			slug: "ask-runs-b",
			name: "Ask Runs B",
		},
	]);
	await db.insert(schema.workspaceMembers).values({
		workspaceId: ids.workspaceA,
		userId: ids.user,
		role: "member",
	});
	await db.insert(schema.workspaceServiceKeys).values({
		id: ids.serviceKey,
		organizationId: ids.organization,
		workspaceId: ids.workspaceA,
		name: "Ask Runs Key",
		prefix: "mk_svc_test",
		keyHash: "a".repeat(64),
		scopes: ["ask"],
	});
	await db.insert(schema.libraries).values([
		{
			id: ids.libraryA,
			organizationId: ids.organization,
			workspaceId: ids.workspaceA,
			ragLibraryId: "rag-ask-runs-a",
			name: "Ask Runs A",
		},
		{
			id: ids.libraryB,
			organizationId: ids.organization,
			workspaceId: ids.workspaceB,
			ragLibraryId: "rag-ask-runs-b",
			name: "Ask Runs B",
		},
	]);
	await db.insert(schema.conversationThreads).values({
		id: ids.thread,
		organizationId: ids.organization,
		workspaceId: ids.workspaceA,
		principalId: ids.user,
		ragLibraryId: "rag-ask-runs-a",
	});
});

after(async () => {
	if (!db || !pool) return;
	await db
		.delete(schema.organizations)
		.where(eq(schema.organizations.id, ids.organization));
	await pool.end();
});

test("Ask runs persist scoped user and service-key metadata through retention", {
	skip: !enabled,
}, async () => {
	assert.ok(repository);
	assert.ok(db);

	const userRequestId = "77000000-0000-4000-8000-000000000001";
	const userStarted = await repository.start({
		requestId: userRequestId,
		otelTraceId: "ABCDEF0123456789ABCDEF0123456789",
		organizationId: ids.organization,
		workspaceId: ids.workspaceA,
		libraryId: ids.libraryA,
		ragLibraryId: "rag-ask-runs-a",
		principal: { type: "user", id: ids.user, threadId: ids.thread },
		queryType: "fact",
	});
	assert.equal(userStarted.ok, true);
	if (!userStarted.ok) return;
	assert.equal(
		userStarted.value.otelTraceId,
		"abcdef0123456789abcdef0123456789",
	);
	assert.equal(userStarted.value.userId, ids.user);
	assert.equal(userStarted.value.serviceKeyId, null);

	const userFinalized = await repository.finalize({
		id: userStarted.value.id,
		requestId: userRequestId,
		organizationId: ids.organization,
		workspaceId: ids.workspaceA,
		status: "refused",
		refuseReason: "insufficient_evidence",
		latencyMs: 42,
		citationCount: 0,
	});
	assert.equal(userFinalized.ok, true);
	assert.equal(userFinalized.ok && userFinalized.value?.status, "refused");

	const serviceRequestId = "77000000-0000-4000-8000-000000000002";
	const serviceStarted = await repository.start({
		requestId: serviceRequestId,
		organizationId: ids.organization,
		workspaceId: ids.workspaceA,
		libraryId: ids.libraryA,
		ragLibraryId: "rag-ask-runs-a",
		principal: { type: "service_key", id: ids.serviceKey },
		startedAt: new Date("2026-06-01T00:00:00.000Z"),
	});
	assert.equal(serviceStarted.ok, true);
	if (!serviceStarted.ok) return;
	assert.equal(serviceStarted.value.userId, null);
	assert.equal(serviceStarted.value.serviceKeyId, ids.serviceKey);

	const serviceFinalized = await repository.finalize({
		id: serviceStarted.value.id,
		requestId: serviceRequestId,
		organizationId: ids.organization,
		workspaceId: ids.workspaceA,
		status: "completed",
		latencyMs: 100,
		citationCount: 3,
		endedAt: new Date("2026-06-01T00:00:00.100Z"),
	});
	assert.equal(serviceFinalized.ok, true);

	const crossWorkspace = await repository.start({
		requestId: "77000000-0000-4000-8000-000000000003",
		organizationId: ids.organization,
		workspaceId: ids.workspaceA,
		libraryId: ids.libraryB,
		ragLibraryId: "rag-ask-runs-b",
		principal: { type: "service_key", id: ids.serviceKey },
	});
	assert.equal(crossWorkspace.ok, false);

	const deleted = await repository.deleteExpired({
		before: new Date("2026-07-01T00:00:00.000Z"),
		organizationId: ids.organization,
		workspaceId: ids.workspaceA,
		limit: 10,
	});
	assert.deepEqual(deleted, { ok: true, value: 1 });

	const [remainingUserRun] = await db
		.select({ id: schema.askRuns.id })
		.from(schema.askRuns)
		.where(
			and(
				eq(schema.askRuns.organizationId, ids.organization),
				eq(schema.askRuns.requestId, userRequestId),
			),
		);
	assert.ok(remainingUserRun);
});
