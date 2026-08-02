#!/usr/bin/env node
/**
 * Reconcile legacy restricted document ACL fingerprints and enqueue durable
 * Qdrant ACL projections.
 *
 * Dry-run is the default:
 *   DATABASE_URL=postgresql://... pnpm acl:backfill-projections
 *
 * Apply changes:
 *   DATABASE_URL=postgresql://... pnpm acl:backfill-projections:apply
 *
 * Optional scope:
 *   --organization-id=<uuid> --workspace-id=<uuid> --limit=<positive integer>
 */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const CANDIDATE_SQL = `
	SELECT document.id
	FROM app.documents AS document
	JOIN app.document_active_versions AS active
	  ON active.document_id = document.id
	WHERE document.status NOT IN ('deleting', 'deleted')
	  AND ($1::uuid IS NULL OR document.organization_id = $1::uuid)
	  AND ($2::uuid IS NULL OR document.workspace_id = $2::uuid)
	  AND EXISTS (
		SELECT 1
		FROM app.document_acl AS acl
		WHERE acl.document_id = document.id
		  AND acl.permission = 'read'
	  )
	ORDER BY document.id
	LIMIT $3
`;

export const LOCK_DOCUMENT_SQL = `
	SELECT
		document.id,
		document.organization_id,
		document.workspace_id,
		document.rag_document_id,
		document.acl_fingerprint,
		document.projected_acl_fingerprint,
		active.version_id AS active_version_id,
		library.rag_library_id
	FROM app.documents AS document
	JOIN app.libraries AS library
	  ON library.id = document.library_id
	 AND library.organization_id = document.organization_id
	 AND library.workspace_id = document.workspace_id
	JOIN app.document_active_versions AS active
	  ON active.document_id = document.id
	JOIN app.document_versions AS version
	  ON version.id = active.version_id
	 AND version.document_id = document.id
	WHERE document.id = $1
	  AND document.status NOT IN ('deleting', 'deleted')
	  AND ($2::uuid IS NULL OR document.organization_id = $2::uuid)
	  AND ($3::uuid IS NULL OR document.workspace_id = $3::uuid)
	FOR UPDATE OF document
`;

export const READ_ACL_SQL = `
	SELECT subject_type, subject_id::text
	FROM app.document_acl
	WHERE document_id = $1
	  AND permission = 'read'
	ORDER BY subject_type, subject_id
`;

export const FIND_ACTIVE_PROJECTION_SQL = `
	SELECT id
	FROM app.jobs
	WHERE organization_id = $1
	  AND workspace_id = $2
	  AND type = 'document.acl.project'
	  AND execution_engine = 'dbos'
	  AND workflow_id = id::text
	  AND status IN ('queued', 'running', 'retry')
	  AND payload ->> 'document_id' = $3
	  AND payload ->> 'acl_fingerprint' = $4
	LIMIT 1
`;

const UPDATE_FINGERPRINT_SQL = `
	UPDATE app.documents
	SET acl_fingerprint = $2,
		updated_at = now()
	WHERE id = $1
	  AND acl_fingerprint IS DISTINCT FROM $2
`;

export const INSERT_PROJECTION_JOB_SQL = `
	INSERT INTO app.jobs (
		id,
		organization_id,
		workspace_id,
		document_version_id,
		type,
		execution_engine,
		workflow_id,
		status,
		stage,
		progress,
		idempotency_key,
		payload,
		created_at,
		updated_at
	) VALUES (
		$1,
		$2,
		$3,
		$4,
		'document.acl.project',
		'dbos',
		$1::uuid::text,
		'queued',
		'accepted',
		0,
		$5,
		$6::jsonb,
		now(),
		now()
	)
`;

export function canonicalAclJson({ scope, principalIds = [], groupIds = [] }) {
	return JSON.stringify({
		scope,
		principalIds:
			scope === "restricted" ? [...new Set(principalIds)].sort() : [],
		groupIds: scope === "restricted" ? [...new Set(groupIds)].sort() : [],
	});
}

export function aclFingerprint(acl) {
	return createHash("sha256").update(canonicalAclJson(acl)).digest("hex");
}

export function parseArguments(argv) {
	const options = {
		apply: false,
		organizationId: null,
		workspaceId: null,
		limit: null,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--apply") {
			options.apply = true;
			continue;
		}

		const matched = [
			["--organization-id", "organizationId"],
			["--workspace-id", "workspaceId"],
			["--limit", "limit"],
		].find(([flag]) => argument === flag || argument.startsWith(`${flag}=`));
		if (!matched) {
			throw new Error(`unknown argument: ${argument}`);
		}

		const [flag, key] = matched;
		const inlineValue = argument.startsWith(`${flag}=`)
			? argument.slice(flag.length + 1)
			: null;
		const value = inlineValue ?? argv[index + 1];
		if (!value || value.startsWith("--")) {
			throw new Error(`${flag} requires a value`);
		}
		if (inlineValue === null) index += 1;

		if (key === "limit") {
			const parsed = Number(value);
			if (!Number.isSafeInteger(parsed) || parsed <= 0) {
				throw new Error("--limit must be a positive integer");
			}
			options.limit = parsed;
			continue;
		}
		if (!UUID_PATTERN.test(value)) {
			throw new Error(`${flag} must be a UUID`);
		}
		options[key] = value.toLowerCase();
	}

	return options;
}

export async function backfillAclProjections(
	client,
	options,
	{ createId = randomUUID } = {},
) {
	const normalized = {
		apply: options.apply === true,
		organizationId: options.organizationId ?? null,
		workspaceId: options.workspaceId ?? null,
		limit: options.limit ?? null,
	};
	const candidates = await client.query(CANDIDATE_SQL, [
		normalized.organizationId,
		normalized.workspaceId,
		normalized.limit,
	]);
	const summary = {
		scanned: candidates.rows.length,
		updated: 0,
		enqueued: 0,
		alreadyProjected: 0,
		alreadyQueued: 0,
	};

	for (const candidate of candidates.rows) {
		await client.query("BEGIN");
		try {
			const outcome = await reconcileDocument(
				client,
				candidate.id,
				normalized,
				createId,
			);
			await client.query("COMMIT");
			summary.updated += outcome.updated;
			summary.enqueued += outcome.enqueued;
			summary.alreadyProjected += outcome.alreadyProjected;
			summary.alreadyQueued += outcome.alreadyQueued;
		} catch (error) {
			await client.query("ROLLBACK").catch(() => undefined);
			throw error;
		}
	}

	return summary;
}

async function reconcileDocument(client, documentId, options, createId) {
	const locked = await client.query(LOCK_DOCUMENT_SQL, [
		documentId,
		options.organizationId,
		options.workspaceId,
	]);
	const document = locked.rows[0];
	if (!document) return emptyOutcome();

	const aclResult = await client.query(READ_ACL_SQL, [documentId]);
	const acl = aclSnapshot(aclResult.rows);
	if (acl.scope !== "restricted") return emptyOutcome();

	const fingerprint = aclFingerprint(acl);
	const needsFingerprintUpdate = document.acl_fingerprint !== fingerprint;
	const alreadyProjected = document.projected_acl_fingerprint === fingerprint;

	if (options.apply && needsFingerprintUpdate) {
		await client.query(UPDATE_FINGERPRINT_SQL, [documentId, fingerprint]);
	}
	if (alreadyProjected) {
		return {
			...emptyOutcome(),
			updated: Number(needsFingerprintUpdate),
			alreadyProjected: 1,
		};
	}

	const existing = await client.query(FIND_ACTIVE_PROJECTION_SQL, [
		document.organization_id,
		document.workspace_id,
		documentId,
		fingerprint,
	]);
	if (existing.rows.length > 0) {
		return {
			...emptyOutcome(),
			updated: Number(needsFingerprintUpdate),
			alreadyQueued: 1,
		};
	}

	if (options.apply) {
		const jobId = createId();
		const payload = JSON.stringify({
			document_id: documentId,
			rag_document_id: document.rag_document_id,
			library_id: document.rag_library_id,
			acl_fingerprint: fingerprint,
		});
		await client.query(INSERT_PROJECTION_JOB_SQL, [
			jobId,
			document.organization_id,
			document.workspace_id,
			document.active_version_id,
			`document.acl.project:backfill:${documentId}:${jobId}`,
			payload,
		]);
	}

	return {
		...emptyOutcome(),
		updated: Number(needsFingerprintUpdate),
		enqueued: 1,
	};
}

function aclSnapshot(rows) {
	const principalIds = [];
	const groupIds = [];
	for (const row of rows) {
		if (row.subject_type === "principal" || row.subject_type === "user") {
			principalIds.push(String(row.subject_id));
		} else if (row.subject_type === "group") {
			groupIds.push(String(row.subject_id));
		} else {
			throw new Error(`unsupported read ACL subject type: ${row.subject_type}`);
		}
	}
	return {
		scope:
			principalIds.length > 0 || groupIds.length > 0
				? "restricted"
				: "workspace",
		principalIds,
		groupIds,
	};
}

function emptyOutcome() {
	return {
		updated: 0,
		enqueued: 0,
		alreadyProjected: 0,
		alreadyQueued: 0,
	};
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (!databaseUrl) throw new Error("DATABASE_URL is required");

	const client = new pg.Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		const summary = await backfillAclProjections(client, options);
		console.log(
			JSON.stringify(
				{ mode: options.apply ? "apply" : "dry-run", ...summary },
				null,
				2,
			),
		);
		if (!options.apply) {
			console.error(
				"dry-run only; re-run with --apply to update fingerprints and enqueue projections",
			);
		}
	} finally {
		await client.end();
	}
}

const invokedPath = process.argv[1]
	? pathToFileURL(path.resolve(process.argv[1])).href
	: null;
if (invokedPath === import.meta.url) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
