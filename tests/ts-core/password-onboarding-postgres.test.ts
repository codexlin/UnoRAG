import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

import pg from "pg";

import {
	hashPassword,
	verifyPasswordSync,
} from "../../src/lib/server/auth/passwords.mjs";
import type { AuthIdentity } from "../../src/lib/server/auth/provider";
import { closeGlobalDatabasePool } from "../helpers/runtime";

type ResolveFilename = (
	request: string,
	parent?: unknown,
	isMain?: boolean,
	options?: unknown,
) => string;

const databaseUrl =
	process.env.PASSWORD_ONBOARDING_TEST_DATABASE_URL?.trim() || undefined;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;

const require = createRequire(import.meta.url);
const nodeModule = require("node:module") as {
	_resolveFilename: ResolveFilename;
};
const originalResolveFilename = nodeModule._resolveFilename.bind(nodeModule);
const inertServerOnlyModule = require.resolve("next/package.json");

nodeModule._resolveFilename = (request, parent, isMain, options) =>
	request === "server-only"
		? inertServerOnlyModule
		: originalResolveFilename(request, parent, isMain, options);
const sessionModule = import("../../src/lib/server/auth/session").finally(
	() => {
		nodeModule._resolveFilename = originalResolveFilename;
	},
);

test("a bootstrap administrator must replace the initial password before normal use", {
	skip: databaseUrl
		? false
		: "PASSWORD_ONBOARDING_TEST_DATABASE_URL is not configured",
}, async () => {
	assert.ok(databaseUrl);
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
	const organizationId = randomUUID();
	const workspaceId = randomUUID();
	const userId = randomUUID();
	const suffix = organizationId.slice(0, 8);
	const email = `password-${suffix}@example.test`;
	const initialPassword = "InitialPassword";
	const nextPassword = "ReplacementPassword";
	const identity: AuthIdentity = {
		tenantId: organizationId,
		workspaceId,
		workspaceName: "Password test",
		principalId: userId,
		groupIds: [],
		organizationRole: "owner",
		role: "owner",
		email,
		displayName: "Password test",
		provider: "local",
		mustChangePassword: true,
	};

	try {
		await pool.query(
			`INSERT INTO app.organizations (id, slug, name)
				 VALUES ($1, $2, 'Password test')`,
			[organizationId, `password-${suffix}`],
		);
		await pool.query(
			`INSERT INTO app.workspaces (id, organization_id, slug, name)
				 VALUES ($1, $2, 'default', 'Password test')`,
			[workspaceId, organizationId],
		);
		await pool.query(
			`INSERT INTO app.users (
					id, organization_id, external_subject, email, display_name,
					organization_role
				 ) VALUES ($1, $2, $3, $4, 'Password test', 'owner')`,
			[userId, organizationId, `password-${suffix}`, email],
		);
		await pool.query(
			`INSERT INTO app.workspace_members (workspace_id, user_id, role)
				 VALUES ($1, $2, 'owner')`,
			[workspaceId, userId],
		);
		await pool.query(
			`INSERT INTO app.local_credentials (
					user_id, password_hash, must_change_password
				 ) VALUES ($1, $2, true)`,
			[userId, hashPassword(initialPassword)],
		);

		const { changeLocalPassword, localIdentityProvider } = await sessionModule;
		assert.deepEqual(
			await localIdentityProvider.authenticate({
				email,
				password: initialPassword,
				workspaceId,
			}),
			{ ...identity },
		);

		assert.deepEqual(
			await changeLocalPassword({
				identity,
				currentPassword: "WrongPassword",
				newPassword: nextPassword,
			}),
			{
				ok: false,
				status: 401,
				detail: "current password is incorrect",
			},
		);
		const weak = await changeLocalPassword({
			identity,
			currentPassword: initialPassword,
			newPassword: "lowercase",
		});
		assert.equal(weak.ok, false);
		if (!weak.ok) assert.equal(weak.status, 400);

		const changed = await changeLocalPassword({
			identity,
			currentPassword: initialPassword,
			newPassword: nextPassword,
		});
		assert.equal(changed.ok, true);
		if (!changed.ok) return;
		assert.equal(changed.identity.mustChangePassword, false);

		const state = await pool.query<{
			password_hash: string;
			must_change_password: boolean;
			failed_attempts: number;
			locked_until: Date | null;
			audit_count: number;
		}>(
			`SELECT credential.password_hash, credential.must_change_password,
					credential.failed_attempts, credential.locked_until,
					(SELECT count(*)::int FROM app.audit_logs
					 WHERE actor_id = $1 AND action = 'auth.password_changed') AS audit_count
				 FROM app.local_credentials AS credential
				 WHERE credential.user_id = $1`,
			[userId],
		);
		assert.equal(state.rows[0]?.must_change_password, false);
		assert.equal(state.rows[0]?.failed_attempts, 0);
		assert.equal(state.rows[0]?.locked_until, null);
		assert.equal(state.rows[0]?.audit_count, 1);
		assert.equal(
			verifyPasswordSync(nextPassword, state.rows[0]?.password_hash ?? ""),
			true,
		);
		assert.equal(
			verifyPasswordSync(initialPassword, state.rows[0]?.password_hash ?? ""),
			false,
		);
		assert.equal(
			await localIdentityProvider.authenticate({
				email,
				password: initialPassword,
				workspaceId,
			}),
			null,
		);
		const signedIn = await localIdentityProvider.authenticate({
			email,
			password: nextPassword,
			workspaceId,
		});
		assert.equal(signedIn?.mustChangePassword, false);
	} finally {
		await pool.query("DELETE FROM app.organizations WHERE id = $1", [
			organizationId,
		]);
		await pool.end();
		await closeGlobalDatabasePool();
	}
});
