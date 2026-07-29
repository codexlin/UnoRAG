import { randomBytes, scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import pg from "pg";

if (existsSync(".env.local")) {
	process.loadEnvFile(".env.local");
}

const { Client } = pg;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function required(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function requiredUuid(name) {
	const value = required(name);
	if (!UUID_PATTERN.test(value)) {
		throw new Error(`${name} must be a UUID`);
	}
	return value;
}

function hashPassword(password) {
	const salt = randomBytes(16);
	const hash = scryptSync(password, salt, 64);
	return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

const upsertPassword =
	String(process.env.UNORAG_ADMIN_PASSWORD_UPSERT || "")
		.trim()
		.toLowerCase() === "1" ||
	String(process.env.UNORAG_ADMIN_PASSWORD_UPSERT || "")
		.trim()
		.toLowerCase() === "true";

const config = {
	databaseUrl: required("DATABASE_URL"),
	organizationId: requiredUuid("UNORAG_ORGANIZATION_ID"),
	organizationSlug: required("UNORAG_ORGANIZATION_SLUG"),
	organizationName: required("UNORAG_ORGANIZATION_NAME"),
	workspaceId: requiredUuid("UNORAG_WORKSPACE_ID"),
	workspaceSlug: required("UNORAG_WORKSPACE_SLUG"),
	workspaceName: required("UNORAG_WORKSPACE_NAME"),
	adminId: requiredUuid("UNORAG_PRINCIPAL_ID"),
	adminSubject: required("UNORAG_ADMIN_SUBJECT"),
	adminEmail: required("UNORAG_ADMIN_EMAIL"),
	adminName: required("UNORAG_ADMIN_NAME"),
	adminPassword: required("UNORAG_ADMIN_PASSWORD"),
};

const client = new Client({ connectionString: config.databaseUrl });
await client.connect();

try {
	await client.query("BEGIN");
	await client.query(
		`
			INSERT INTO app.organizations (id, slug, name, deployment_mode, status)
			VALUES ($1, $2, $3, 'private', 'active')
			ON CONFLICT (id) DO UPDATE
			SET slug = EXCLUDED.slug, name = EXCLUDED.name, updated_at = now()
		`,
		[config.organizationId, config.organizationSlug, config.organizationName],
	);
	await client.query(
		`
			INSERT INTO app.workspaces (id, organization_id, slug, name, status)
			VALUES ($1, $2, $3, $4, 'active')
			ON CONFLICT (id) DO UPDATE
			SET name = EXCLUDED.name, updated_at = now()
		`,
		[
			config.workspaceId,
			config.organizationId,
			config.workspaceSlug,
			config.workspaceName,
		],
	);
	await client.query(
		`
			INSERT INTO app.users (
				id, organization_id, external_subject, email, display_name,
				organization_role, status
			)
			VALUES ($1, $2, $3, $4, $5, 'owner', 'active')
			ON CONFLICT (id) DO UPDATE
			SET email = EXCLUDED.email,
				display_name = EXCLUDED.display_name,
				organization_role = 'owner',
				updated_at = now()
		`,
		[
			config.adminId,
			config.organizationId,
			config.adminSubject,
			config.adminEmail,
			config.adminName,
		],
	);
	await client.query(
		`
			INSERT INTO app.workspace_members (workspace_id, user_id, role)
			VALUES ($1, $2, 'owner')
			ON CONFLICT (workspace_id, user_id) DO UPDATE
			SET role = 'owner', updated_at = now()
		`,
		[config.workspaceId, config.adminId],
	);
	// Create-only by default so re-install / re-bootstrap does not reset passwords.
	// Opt-in rotation: UNORAG_ADMIN_PASSWORD_UPSERT=1
	if (upsertPassword) {
		await client.query(
			`
				INSERT INTO app.local_credentials (user_id, password_hash)
				VALUES ($1, $2)
				ON CONFLICT (user_id) DO UPDATE
				SET password_hash = EXCLUDED.password_hash,
					failed_attempts = 0,
					locked_until = NULL,
					updated_at = now()
			`,
			[config.adminId, hashPassword(config.adminPassword)],
		);
		console.log(
			`Bootstrapped (password upsert) organization=${config.organizationId} workspace=${config.workspaceId} admin=${config.adminId}`,
		);
	} else {
		const inserted = await client.query(
			`
				INSERT INTO app.local_credentials (user_id, password_hash)
				VALUES ($1, $2)
				ON CONFLICT (user_id) DO NOTHING
				RETURNING user_id
			`,
			[config.adminId, hashPassword(config.adminPassword)],
		);
		const created = (inserted.rowCount ?? 0) > 0;
		console.log(
			`Bootstrapped organization=${config.organizationId} workspace=${config.workspaceId} admin=${config.adminId} password=${created ? "created" : "kept"}`,
		);
	}
	await client.query("COMMIT");
} catch (error) {
	await client.query("ROLLBACK");
	throw error;
} finally {
	await client.end();
}
