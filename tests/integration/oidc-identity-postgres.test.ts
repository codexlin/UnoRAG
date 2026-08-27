import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";

import pg from "pg";

const databaseUrl = process.env.OIDC_AUTH_TEST_DATABASE_URL?.trim();
const skipReason = databaseUrl
	? false
	: "OIDC_AUTH_TEST_DATABASE_URL is not configured";

test("OIDC links local recovery accounts, provisions invited users, and rejects strangers", {
	skip: skipReason,
}, async () => {
	if (!databaseUrl) return;
	process.env.DATABASE_URL = databaseUrl;
	const { resolveOidcClaimsIdentity } = await import(
		"../../src/lib/server/auth/oidc-provider"
	);
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
	const organizationId = randomUUID();
	const workspaceId = randomUUID();
	const existingUserId = randomUUID();
	const issuer = "https://id.example.com/realms/acme";
	const settings = {
		issuerUrl: issuer,
		clientId: "unorag-test",
		clientSecret: "not-used-by-claim-resolution",
		clientAuthMethod: "client_secret_post" as const,
		scopes: "openid profile email",
		organizationId,
		buttonLabel: "SSO",
		trustEmailClaim: false,
	};

	try {
		await pool.query(
			`insert into app.organizations (id, slug, name)
				 values ($1, $2, 'OIDC Integration')`,
			[organizationId, `oidc-${organizationId.slice(0, 8)}`],
		);
		await pool.query(
			`insert into app.workspaces (id, organization_id, slug, name)
				 values ($1, $2, 'default', 'Default')`,
			[workspaceId, organizationId],
		);
		await pool.query(
			`insert into app.users
				 (id, organization_id, external_subject, email, display_name, organization_role)
				 values ($1, $2, 'local:owner', 'owner@example.com', 'Owner', 'owner')`,
			[existingUserId, organizationId],
		);
		await pool.query(
			`insert into app.local_credentials (user_id, password_hash)
				 values ($1, 'scrypt$00$00')`,
			[existingUserId],
		);
		await pool.query(
			`insert into app.workspace_members (workspace_id, user_id, role)
				 values ($1, $2, 'owner')`,
			[workspaceId, existingUserId],
		);

		const linked = await resolveOidcClaimsIdentity(settings, {
			iss: issuer,
			sub: "owner-subject",
			email: "owner@example.com",
			email_verified: true,
			name: "Enterprise Owner",
		});
		assert.equal(linked?.principalId, existingUserId);
		assert.equal(linked?.provider, "oidc");
		const localCredential = await pool.query(
			"select password_hash from app.local_credentials where user_id = $1",
			[existingUserId],
		);
		assert.equal(localCredential.rowCount, 1);

		const inviteId = randomUUID();
		await pool.query(
			`insert into app.workspace_invites
				 (id, organization_id, workspace_id, email, role, token_hash, expires_at)
				 values ($1, $2, $3, 'member@example.com', 'editor', $4, now() + interval '1 hour')`,
			[inviteId, organizationId, workspaceId, randomBytes(32).toString("hex")],
		);
		const invited = await resolveOidcClaimsIdentity(settings, {
			iss: issuer,
			sub: "member-subject",
			email: "member@example.com",
			email_verified: true,
			name: "Invited Member",
		});
		assert.equal(invited?.role, "editor");
		assert.equal(invited?.provider, "oidc");
		const invite = await pool.query(
			"select status, accepted_user_id from app.workspace_invites where id = $1",
			[inviteId],
		);
		assert.equal(invite.rows[0]?.status, "accepted");
		assert.equal(invite.rows[0]?.accepted_user_id, invited?.principalId);

		const stranger = await resolveOidcClaimsIdentity(settings, {
			iss: issuer,
			sub: "stranger-subject",
			email: "stranger@example.com",
			email_verified: true,
		});
		assert.equal(stranger, null);

		const audit = await pool.query(
			`select count(*)::int as count from app.audit_logs
				 where organization_id = $1 and action = 'auth.oidc.login'`,
			[organizationId],
		);
		assert.equal(audit.rows[0]?.count, 2);
	} finally {
		await pool.query("delete from app.organizations where id = $1", [
			organizationId,
		]);
		await pool.end();
	}
});
