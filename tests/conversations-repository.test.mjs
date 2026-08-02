import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
	return readFileSync(path.join(root, relativePath), "utf8");
}

test("conversation migration creates only app-scoped thread and turn tables", () => {
	const migration = read("drizzle/0014_scoped_conversations.sql");

	assert.match(migration, /CREATE TABLE "app"\."threads"/);
	assert.match(migration, /CREATE TABLE "app"\."turns"/);
	assert.doesNotMatch(migration, /"public"\."(?:threads|turns)"/);
	assert.match(migration, /"organization_id" uuid NOT NULL/);
	assert.match(migration, /"workspace_id" uuid NOT NULL/);
	assert.match(migration, /"principal_id" uuid NOT NULL/);
	assert.match(migration, /"rag_library_id" varchar\(128\)/);
	assert.match(migration, /"title" varchar\(256\)/);
	assert.match(migration, /"citations" jsonb DEFAULT '\[\]'::jsonb NOT NULL/);
	assert.match(migration, /"debug" jsonb/);
	assert.match(migration, /"usage" jsonb/);
});

test("conversation migration installs scope indexes before composite foreign keys", () => {
	const migration = read("drizzle/0014_scoped_conversations.sql");
	const usersIndex = migration.indexOf('CREATE UNIQUE INDEX "users_org_id_uq"');
	const workspacesIndex = migration.indexOf(
		'CREATE UNIQUE INDEX "workspaces_org_id_uq"',
	);
	const librariesIndex = migration.indexOf(
		'CREATE UNIQUE INDEX "libraries_scope_rag_id_uq"',
	);
	const threadsIndex = migration.indexOf(
		'CREATE UNIQUE INDEX "threads_id_scope_uq"',
	);

	assert.ok(usersIndex >= 0);
	assert.ok(workspacesIndex >= 0);
	assert.ok(librariesIndex >= 0);
	assert.ok(threadsIndex >= 0);
	assert.ok(usersIndex < migration.indexOf('"threads_org_principal_fk"'));
	assert.ok(workspacesIndex < migration.indexOf('"threads_org_workspace_fk"'));
	assert.ok(librariesIndex < migration.indexOf('"threads_scope_library_fk"'));
	assert.ok(threadsIndex < migration.indexOf('"turns_thread_scope_fk"'));
	assert.match(migration, /"threads_workspace_principal_fk"/);
	assert.match(migration, /"turns_thread_sequence_uq"/);
	assert.match(migration, /"turns_scope_thread_sequence_idx"/);
});

test("conversation repository applies scope to every read and append query", () => {
	const repository = read("src/server/conversations/repository.ts");

	for (const field of ["organizationId", "workspaceId", "principalId"]) {
		assert.match(
			repository,
			new RegExp(`eq\\(conversationThreads\\.${field}, scope\\.${field}\\)`),
		);
		assert.match(
			repository,
			new RegExp(`eq\\(conversationTurns\\.${field}, scope\\.${field}\\)`),
		);
	}
	assert.match(repository, /async createThread\(/);
	assert.match(repository, /async getThread\(/);
	assert.match(repository, /async listThreads\(/);
	assert.match(repository, /async listTurns\(/);
	assert.match(repository, /async appendTurn\(/);
	assert.match(repository, /this\.db\.transaction/);
	assert.match(repository, /\.for\("update"\)/);
	assert.match(
		repository,
		/const sequence = \(latest\?\.sequence \?\? 0\) \+ 1/,
	);
	assert.match(
		repository,
		/orderBy\(asc\(conversationTurns\.sequence\), asc\(conversationTurns\.id\)\)/,
	);
});

test("conversation schema uses composite scope constraints and stable statuses", () => {
	const schema = read("src/db/schema.ts");

	assert.match(schema, /export const conversationThreads = appSchema\.table/);
	assert.match(schema, /export const conversationTurns = appSchema\.table/);
	assert.match(schema, /name: "threads_org_workspace_fk"/);
	assert.match(schema, /name: "threads_org_principal_fk"/);
	assert.match(schema, /name: "threads_workspace_principal_fk"/);
	assert.match(schema, /name: "threads_scope_library_fk"/);
	assert.match(schema, /name: "turns_thread_scope_fk"/);
	assert.match(
		schema,
		/sql`\$\{table\.role\} in \('system', 'user', 'assistant', 'tool'\)`/,
	);
	assert.match(
		schema,
		/'pending', 'complete', 'failed', 'cancelled', 'truncated'/,
	);
});
