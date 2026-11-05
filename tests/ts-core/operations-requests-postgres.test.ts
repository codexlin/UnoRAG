import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "../../src/db/schema";
import { OPERATIONS_REQUEST_STATUSES } from "../../src/lib/operations-requests";
import type { AuthIdentity } from "../../src/lib/server/auth/provider";
import { OperationsRequestsService } from "../../src/server/observability/operations-requests-service";
import { closeGlobalDatabasePool } from "../helpers/runtime";

const databaseUrl = process.env.ASK_RUNS_TEST_DATABASE_URL?.trim();
const redisUrl = process.env.REDIS_INTEGRATION_TEST_URL?.trim();

test("Ask request browser uses real PostgreSQL ordering/filters and live session workspace authorization", {
	skip:
		databaseUrl && redisUrl
			? false
			: "ASK_RUNS_TEST_DATABASE_URL and REDIS_INTEGRATION_TEST_URL are required",
}, async () => {
	assert.ok(databaseUrl);
	assert.ok(redisUrl);
	process.env.DATABASE_URL = databaseUrl;
	process.env.REDIS_URL = redisUrl;
	process.env.UNORAG_SESSION_SECRET ||=
		"operations-requests-integration-secret-000000000000000000";
	const require = createRequire(import.meta.url);
	const nodeModule = require("node:module") as {
		_resolveFilename: (
			request: string,
			parent?: unknown,
			isMain?: boolean,
			options?: unknown,
		) => string;
	};
	const original = nodeModule._resolveFilename.bind(nodeModule);
	const inert = require.resolve("next/package.json");
	// Match the existing route harness: server-only is a build-time marker.
	nodeModule._resolveFilename = (request, parent, isMain, options) =>
		request === "server-only"
			? inert
			: original(request, parent, isMain, options);
	const [session, securityRedis, route] = await Promise.all([
		import("../../src/lib/server/auth/session"),
		import("../../src/lib/server/security/redis"),
		import("../../src/app/api/workspace/operations/requests/route"),
	]).finally(() => {
		nodeModule._resolveFilename = original;
	});

	const pool = new Pool({ connectionString: databaseUrl, max: 3 });
	const db = drizzle(pool, { schema });
	const service = new OperationsRequestsService(db);
	const org = randomUUID();
	const otherOrg = randomUUID();
	const workspace = randomUUID();
	const otherWorkspace = randomUUID();
	const foreignWorkspace = randomUUID();
	const user = randomUUID();
	const library = randomUUID();
	const secondLibrary = randomUUID();
	const otherLibrary = randomUUID();
	const foreignLibrary = randomUUID();
	const key = randomUUID();
	const otherKey = randomUUID();
	const foreignKey = randomUUID();
	const publicLibrary = `requests-${library}`;
	const scope = { organizationId: org, workspaceId: workspace };
	const now = new Date();
	const tiedTime = new Date(Math.floor((now.getTime() - 60_000) / 1000) * 1000)
		.toISOString()
		.replace(".000Z", ".123456Z");
	const tokens: string[] = [];
	const identity: AuthIdentity = {
		tenantId: org,
		workspaceId: workspace,
		workspaceName: "Requests test",
		principalId: user,
		groupIds: [],
		organizationRole: "owner",
		role: "owner",
		email: null,
		displayName: "Requests test",
		provider: "local",
		mustChangePassword: false,
	};

	try {
		await db.insert(schema.organizations).values(
			[org, otherOrg].map((id) => ({
				id,
				slug: `requests-${id}`,
				name: "Requests test",
			})),
		);
		await db.insert(schema.workspaces).values([
			{
				id: workspace,
				organizationId: org,
				slug: "requests-a",
				name: "Requests A",
			},
			{
				id: otherWorkspace,
				organizationId: org,
				slug: "requests-b",
				name: "Requests B",
			},
			{
				id: foreignWorkspace,
				organizationId: otherOrg,
				slug: "requests-c",
				name: "Requests C",
			},
		]);
		await db.insert(schema.users).values({
			id: user,
			organizationId: org,
			externalSubject: `requests-${user}`,
			displayName: "Requests test",
			organizationRole: "owner",
		});
		await db
			.insert(schema.localCredentials)
			.values({ userId: user, passwordHash: "not-used-in-cookie-tests" });
		await db
			.insert(schema.workspaceMembers)
			.values({ workspaceId: workspace, userId: user, role: "owner" });
		await db.insert(schema.libraries).values([
			{
				id: library,
				organizationId: org,
				workspaceId: workspace,
				ragLibraryId: publicLibrary,
				name: "Main",
			},
			{
				id: secondLibrary,
				organizationId: org,
				workspaceId: workspace,
				ragLibraryId: `requests-${secondLibrary}`,
				name: "Second",
			},
			{
				id: otherLibrary,
				organizationId: org,
				workspaceId: otherWorkspace,
				ragLibraryId: `requests-${otherLibrary}`,
				name: "Other",
			},
			{
				id: foreignLibrary,
				organizationId: otherOrg,
				workspaceId: foreignWorkspace,
				ragLibraryId: `requests-${foreignLibrary}`,
				name: "Foreign",
			},
		]);
		await db.insert(schema.workspaceServiceKeys).values(
			[
				{ id: key, organizationId: org, workspaceId: workspace },
				{ id: otherKey, organizationId: org, workspaceId: otherWorkspace },
				{
					id: foreignKey,
					organizationId: otherOrg,
					workspaceId: foreignWorkspace,
				},
			].map((value) => ({
				...value,
				name: "Requests test",
				prefix: value.id.slice(0, 8),
				keyHash: value.id.replaceAll("-", "").repeat(2),
				scopes: ["ask"],
			})),
		);

		const tied = OPERATIONS_REQUEST_STATUSES.map((status) => ({
			id: randomUUID(),
			requestId: randomUUID(),
			organizationId: org,
			workspaceId: workspace,
			libraryId: library,
			ragLibraryId: publicLibrary,
			principalType: "service_key",
			serviceKeyId: key,
			status,
			startedAt: new Date(tiedTime),
			endedAt: status === "running" ? null : now,
			latencyMs:
				status === "running" ? null : status === "completed" ? 1000 : 500,
			refuseReason: status === "refused" ? "insufficient_evidence" : null,
			queryType: "fact",
			retrievalMode: "hybrid",
			citationCount: status === "completed" ? 2 : 0,
			errorCode: "private raw error sk-secret",
		}));
		await db.insert(schema.askRuns).values(tied);
		await pool.query(
			"UPDATE app.ask_runs SET started_at = $1::timestamptz WHERE id = ANY($2::uuid[])",
			[tiedTime, tied.map((row) => row.id)],
		);
		const base = tied.find((row) => row.status === "completed");
		assert.ok(base);
		const microRows = ["123455", "123454"].map((micro) => ({
			...base,
			id: randomUUID(),
			requestId: randomUUID(),
			queryType: "table",
			latencyMs: 1500,
			micro,
		}));
		for (const { micro, ...row } of microRows) {
			await db.insert(schema.askRuns).values(row);
			await pool.query(
				"UPDATE app.ask_runs SET started_at = $1::timestamptz WHERE id = $2",
				[tiedTime.replace("123456", micro), row.id],
			);
		}
		const old = {
			...base,
			id: randomUUID(),
			requestId: randomUUID(),
			startedAt: new Date(now.getTime() - 25 * 3_600_000),
		};
		const tooOld = {
			...old,
			id: randomUUID(),
			requestId: randomUUID(),
			startedAt: new Date(now.getTime() - 8 * 86_400_000),
		};
		const future = {
			...base,
			id: randomUUID(),
			requestId: randomUUID(),
			startedAt: new Date(now.getTime() + 3_600_000),
		};
		const second = {
			...base,
			id: randomUUID(),
			requestId: randomUUID(),
			libraryId: secondLibrary,
			ragLibraryId: `requests-${secondLibrary}`,
		};
		const other = {
			...base,
			id: randomUUID(),
			requestId: randomUUID(),
			workspaceId: otherWorkspace,
			libraryId: otherLibrary,
			ragLibraryId: `requests-${otherLibrary}`,
			serviceKeyId: otherKey,
		};
		const foreign = {
			...base,
			id: randomUUID(),
			requestId: randomUUID(),
			organizationId: otherOrg,
			workspaceId: foreignWorkspace,
			libraryId: foreignLibrary,
			ragLibraryId: `requests-${foreignLibrary}`,
			serviceKeyId: foreignKey,
		};
		await db
			.insert(schema.askRuns)
			.values([old, tooOld, future, second, other, foreign]);
		await db.insert(schema.askRunStages).values({
			askRunId: base.id,
			organizationId: org,
			workspaceId: workspace,
			sequence: 1,
			stage: "generate",
			outcome: "completed",
			durationMs: 100,
			detail: {
				question: "private question",
				answer: "private answer",
				prompt: "private prompt",
				chunk: "private chunk",
				key: "sk-secret",
			},
		});

		const list = (query: Record<string, string> = {}) =>
			service.list(scope, new URLSearchParams(query), now);
		const all = await list();
		assert.equal(all.items.length, 8);
		assert.deepEqual(
			new Set(all.items.map((row) => row.status)),
			new Set(OPERATIONS_REQUEST_STATUSES),
		);
		assert.equal(
			all.items.find((row) => row.status === "running")?.latency_ms,
			null,
		);
		assert.equal(
			all.items.find((row) => row.status === "running")?.ended_at,
			null,
		);
		assert.doesNotMatch(
			JSON.stringify(all),
			/private|sk-secret|question|answer|prompt|chunk|error_code|token|principal/,
		);
		assert.equal((await list({ range: "7d" })).items.length, 9);
		assert.equal((await list({ range: "1h" })).items.length, 8);
		for (const status of OPERATIONS_REQUEST_STATUSES) {
			const filtered = await list({ status });
			assert.ok(filtered.items.length > 0);
			assert.ok(filtered.items.every((row) => row.status === status));
		}
		assert.equal((await list({ library_id: publicLibrary })).items.length, 7);
		assert.deepEqual(
			(
				await list({
					library_id: publicLibrary,
					query_type: "table",
					min_latency_ms: "1500",
					status: "completed",
				})
			).items.map((row) => row.id),
			microRows.map((row) => row.id),
		);
		assert.equal((await list({ min_latency_ms: "1501" })).items.length, 0);
		assert.deepEqual(
			(await list({ request_id: base.requestId })).items.map((row) => row.id),
			[base.id],
		);
		assert.equal((await list({ request_id: other.requestId })).items.length, 0);
		assert.equal(
			(await list({ request_id: foreign.requestId })).items.length,
			0,
		);
		assert.equal(
			(await list({ library_id: other.ragLibraryId })).items.length,
			0,
		);
		assert.equal(
			(
				await service.list(
					{ ...scope, organizationId: otherOrg },
					new URLSearchParams(),
					now,
				)
			).items.length,
			0,
		);

		const seen: string[] = [];
		let cursor: string | null = null;
		do {
			const page = await list({
				library_id: publicLibrary,
				limit: "2",
				...(cursor ? { cursor } : {}),
			});
			seen.push(...page.items.map((row) => row.id));
			cursor = page.next_cursor;
			assert.ok(seen.length <= 7);
		} while (cursor);
		assert.deepEqual(seen, [
			...tied
				.map((row) => row.id)
				.sort()
				.reverse(),
			...microRows.map((row) => row.id),
		]);
		assert.equal(new Set(seen).size, 7);

		const token = await session.issueSessionToken(identity);
		tokens.push(token);
		const get = (query = "", cookie = `${session.SESSION_COOKIE}=${token}`) =>
			route.GET(
				new Request(`http://local/api/workspace/operations/requests${query}`, {
					headers: { cookie },
				}),
			);
		const checkResponse = async (response: Response, status: number) => {
			assert.equal(response.status, status);
			assert.equal(response.headers.get("cache-control"), "private, no-store");
			return response.json();
		};
		await checkResponse(await get("", ""), 401);
		await checkResponse(await get("", "unorag_session=invalid"), 401);
		await checkResponse(await get("?range=invalid", ""), 401);
		await checkResponse(
			await route.GET(
				new Request("http://local/api/workspace/operations/requests", {
					headers: { authorization: "Bearer mk_svc_not-a-session" },
				}),
			),
			401,
		);
		for (const role of ["viewer", "editor", "admin", "owner"]) {
			await db
				.update(schema.workspaceMembers)
				.set({ role })
				.where(eq(schema.workspaceMembers.userId, user));
			const body = await checkResponse(
				await get(),
				role === "admin" || role === "owner" ? 200 : 403,
			);
			if (role === "admin" || role === "owner")
				assert.equal(body.items.length, 8);
			else await checkResponse(await get("?range=invalid"), 403);
		}
		const globalDatabase = globalThis as typeof globalThis & {
			unoragPool?: Pool;
		};
		const originalPool = globalDatabase.unoragPool;
		try {
			globalDatabase.unoragPool = {
				query: async () => {
					throw new Error("private provider response sk-secret");
				},
			} as unknown as Pool;
			assert.deepEqual(await checkResponse(await get(), 503), {
				detail: "request records unavailable",
			});
		} finally {
			globalDatabase.unoragPool = originalPool;
		}
		for (const invalid of [
			"?range=30d",
			"?limit=101",
			"?query_type=private-question",
			"?status=dead",
			"?cursor=invalid",
			`?workspace_id=${otherWorkspace}`,
			"?limit=1&limit=2",
			"?request_id=partial",
		]) {
			assert.deepEqual(await checkResponse(await get(invalid), 400), {
				detail: "invalid request filters or cursor",
			});
		}
		assert.equal(
			(await checkResponse(await get(`?request_id=${other.requestId}`), 200))
				.items.length,
			0,
		);
		assert.equal(
			(await checkResponse(await get(`?request_id=${base.requestId}`), 200))
				.items[0].id,
			base.id,
		);
		await db
			.update(schema.localCredentials)
			.set({ mustChangePassword: true })
			.where(eq(schema.localCredentials.userId, user));
		await checkResponse(await get(), 401);
		await db
			.update(schema.localCredentials)
			.set({ mustChangePassword: false })
			.where(eq(schema.localCredentials.userId, user));
		await session.revokeSessionCookieHeader(
			`${session.SESSION_COOKIE}=${token}`,
		);
		await checkResponse(await get(), 401);

		const boundaryRows = ["from", "to", "before", "after"].map((name) => ({
			...base,
			id: randomUUID(),
			requestId: randomUUID(),
			queryType: "summary",
			name,
		}));
		for (const { name, ...row } of boundaryRows) {
			await db.insert(schema.askRuns).values(row);
			const bound =
				name === "from" || name === "before"
					? new Date(now.getTime() - 3_600_000).toISOString()
					: now.toISOString();
			const offset = name === "before" ? -1 : name === "after" ? 1 : 0;
			await pool.query(
				"UPDATE app.ask_runs SET started_at = $1::timestamptz + $2::int * interval '1 microsecond' WHERE id = $3",
				[bound, offset, row.id],
			);
		}
		assert.deepEqual(
			(await list({ range: "1h", query_type: "summary" })).items.map(
				(row) => row.id,
			),
			[boundaryRows[1].id, boundaryRows[0].id],
		);
	} finally {
		for (const token of tokens)
			await session.revokeSessionCookieHeader(
				`${session.SESSION_COOKIE}=${token}`,
			);
		await securityRedis.closeSecurityRedisForTests();
		await db
			.delete(schema.organizations)
			.where(inArray(schema.organizations.id, [org, otherOrg]));
		await pool.end();
		await closeGlobalDatabasePool();
	}
});
