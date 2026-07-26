#!/usr/bin/env node
/**
 * Bootstrap (or teardown) the S1/S2 isolation acceptance topology:
 *
 *   Organization A
 *   ├── Workspace A1  (owner + restricted viewer)
 *   └── Workspace A2  (owner)
 *   Organization B
 *   └── Workspace B1  (owner)
 *
 * Uses control-plane SQL (same pattern as apps/web/scripts/bootstrap-control-plane.mjs).
 * Exit: 0 ok, 1 fail, 2 skip (missing DATABASE_URL / pg).
 */
import { randomBytes, scryptSync } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
// Reuse apps/web dependency (pg) without a separate package root.
const require = createRequire(join(ROOT, "apps/web/package.json"));
const pg = require("pg");

for (const rel of ["apps/web/.env.local", "deploy/compose/.env", ".env"]) {
	const path = join(ROOT, rel);
	if (existsSync(path)) {
		process.loadEnvFile(path);
		break;
	}
}

const { Client } = pg;

const IDS = {
	orgA: "a1000000-0000-4000-8000-000000000001",
	wsA1: "a1000000-0000-4000-8000-000000000011",
	wsA2: "a1000000-0000-4000-8000-000000000012",
	orgB: "b1000000-0000-4000-8000-000000000001",
	wsB1: "b1000000-0000-4000-8000-000000000011",
	userA1: "a1000000-0000-4000-8000-000000000101",
	userA1Viewer: "a1000000-0000-4000-8000-000000000102",
	userA2: "a1000000-0000-4000-8000-000000000201",
	userB1: "b1000000-0000-4000-8000-000000000301",
};

const USERS = [
	{
		id: IDS.userA1,
		org: IDS.orgA,
		email: "iso-a1-owner@meriknow.isolation.test",
		name: "ISO A1 Owner",
		subject: "iso-a1-owner",
		workspace: IDS.wsA1,
		role: "owner",
	},
	{
		id: IDS.userA1Viewer,
		org: IDS.orgA,
		email: "iso-a1-viewer@meriknow.isolation.test",
		name: "ISO A1 Viewer",
		subject: "iso-a1-viewer",
		workspace: IDS.wsA1,
		role: "viewer",
	},
	{
		id: IDS.userA2,
		org: IDS.orgA,
		email: "iso-a2-owner@meriknow.isolation.test",
		name: "ISO A2 Owner",
		subject: "iso-a2-owner",
		workspace: IDS.wsA2,
		role: "owner",
	},
	{
		id: IDS.userB1,
		org: IDS.orgB,
		email: "iso-b1-owner@meriknow.isolation.test",
		name: "ISO B1 Owner",
		subject: "iso-b1-owner",
		workspace: IDS.wsB1,
		role: "owner",
	},
];

function hashPassword(password) {
	const salt = randomBytes(16);
	const hash = scryptSync(password, salt, 64);
	return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function usage() {
	console.log(`Usage: node bootstrap_isolation_topology.mjs [--cleanup] [--out path]

Env:
  DATABASE_URL                 required (apps/web/.env.local or compose .env)
  MERIKNOW_ISOLATION_PASSWORD  default IsolationPilot!2026
`);
}

async function cleanup(client) {
	// Cascade from organizations removes workspaces/users/memberships/credentials.
	await client.query("DELETE FROM app.organizations WHERE id = ANY($1::uuid[])", [
		[IDS.orgA, IDS.orgB],
	]);
	console.log("cleanup: removed isolation orgs A/B and cascaded rows");
}

async function bootstrap(client, password) {
	await client.query("BEGIN");
	try {
		await client.query(
			`
			INSERT INTO app.organizations (id, slug, name, deployment_mode, status)
			VALUES
				($1, 'iso-org-a', 'Isolation Org A', 'private', 'active'),
				($2, 'iso-org-b', 'Isolation Org B', 'private', 'active')
			ON CONFLICT (id) DO UPDATE
			SET slug = EXCLUDED.slug, name = EXCLUDED.name, status = 'active', updated_at = now()
			`,
			[IDS.orgA, IDS.orgB],
		);
		await client.query(
			`
			INSERT INTO app.workspaces (id, organization_id, slug, name, status)
			VALUES
				($1, $2, 'iso-ws-a1', 'Isolation Workspace A1', 'active'),
				($3, $2, 'iso-ws-a2', 'Isolation Workspace A2', 'active'),
				($4, $5, 'iso-ws-b1', 'Isolation Workspace B1', 'active')
			ON CONFLICT (id) DO UPDATE
			SET name = EXCLUDED.name, status = 'active', updated_at = now()
			`,
			[IDS.wsA1, IDS.orgA, IDS.wsA2, IDS.wsB1, IDS.orgB],
		);

		for (const u of USERS) {
			await client.query(
				`
				INSERT INTO app.users (
					id, organization_id, external_subject, email, display_name, status
				)
				VALUES ($1, $2, $3, $4, $5, 'active')
				ON CONFLICT (id) DO UPDATE
				SET email = EXCLUDED.email,
					display_name = EXCLUDED.display_name,
					status = 'active',
					updated_at = now()
				`,
				[u.id, u.org, u.subject, u.email, u.name],
			);
			await client.query(
				`
				INSERT INTO app.workspace_members (workspace_id, user_id, role)
				VALUES ($1, $2, $3)
				ON CONFLICT (workspace_id, user_id) DO UPDATE
				SET role = EXCLUDED.role, updated_at = now()
				`,
				[u.workspace, u.id, u.role],
			);
			const cred = await client.query(
				"SELECT 1 FROM app.local_credentials WHERE user_id = $1",
				[u.id],
			);
			if (cred.rowCount === 0) {
				await client.query(
					`
					INSERT INTO app.local_credentials (user_id, password_hash)
					VALUES ($1, $2)
					`,
					[u.id, hashPassword(password)],
				);
			} else {
				await client.query(
					`
					UPDATE app.local_credentials
					SET password_hash = $2, failed_attempts = 0, locked_until = NULL, updated_at = now()
					WHERE user_id = $1
					`,
					[u.id, hashPassword(password)],
				);
			}
		}
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	}
}

async function main() {
	const args = process.argv.slice(2);
	if (args.includes("-h") || args.includes("--help")) {
		usage();
		process.exit(0);
	}
	const doCleanup = args.includes("--cleanup");
	const outIdx = args.indexOf("--out");
	const outPath =
		outIdx >= 0
			? args[outIdx + 1]
			: join(__dirname, ".isolation-topology.json");

	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (!databaseUrl) {
		console.error("SKIP: DATABASE_URL is required");
		process.exit(2);
	}
	const password =
		process.env.MERIKNOW_ISOLATION_PASSWORD?.trim() || "IsolationPilot!2026";

	const client = new Client({ connectionString: databaseUrl });
	try {
		await client.connect();
	} catch (error) {
		console.error(`SKIP: cannot connect to DATABASE_URL (${error.message})`);
		process.exit(2);
	}

	try {
		if (doCleanup) {
			await cleanup(client);
			if (existsSync(outPath)) {
				writeFileSync(outPath, JSON.stringify({ cleaned: true }, null, 2));
			}
			process.exit(0);
		}
		await bootstrap(client, password);
		const manifest = {
			password_env: "MERIKNOW_ISOLATION_PASSWORD",
			password_default_used: !process.env.MERIKNOW_ISOLATION_PASSWORD?.trim(),
			organizations: {
				A: { id: IDS.orgA, slug: "iso-org-a" },
				B: { id: IDS.orgB, slug: "iso-org-b" },
			},
			workspaces: {
				A1: { id: IDS.wsA1, org: "A", slug: "iso-ws-a1" },
				A2: { id: IDS.wsA2, org: "A", slug: "iso-ws-a2" },
				B1: { id: IDS.wsB1, org: "B", slug: "iso-ws-b1" },
			},
			users: USERS.map((u) => ({
				id: u.id,
				email: u.email,
				role: u.role,
				workspace: u.workspace,
			})),
		};
		writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
		console.log(`bootstrap ok → ${outPath}`);
		console.log(
			"logins:",
			USERS.map((u) => `${u.email} @ ${u.workspace}`).join(" | "),
		);
	} finally {
		await client.end();
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
