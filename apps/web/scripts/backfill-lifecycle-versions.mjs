#!/usr/bin/env node
/**
 * Backfill app.document_versions + desired/active pointers for legacy
 * app.documents rows created before the lifecycle control plane.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node scripts/backfill-lifecycle-versions.mjs
 *   DATABASE_URL=... node scripts/backfill-lifecycle-versions.mjs --apply
 *   DATABASE_URL=... node scripts/backfill-lifecycle-versions.mjs --apply --limit=100
 *
 * Dry-run by default. When --apply:
 * - creates version 1 when none exist (or repairs missing desired_version_id)
 * - copies storage_key/content_hash from public.documents when available
 * - for ready/degraded docs with storage: sets active + rag.active_document_generations
 * - docs without storage get a placeholder key and stay non-active (operator must reindex)
 */
import { randomUUID } from "node:crypto";

import pg from "pg";

const apply = process.argv.includes("--apply");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : null;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	console.error("DATABASE_URL is required");
	process.exit(1);
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

const summary = {
	mode: apply ? "apply" : "dry-run",
	scanned: 0,
	would_create_version: 0,
	would_set_desired: 0,
	would_activate: 0,
	missing_storage: 0,
	already_ok: 0,
	applied: 0,
	errors: [],
};

try {
	const hasPublic = await client.query(`
		SELECT to_regclass('public.documents') IS NOT NULL AS present
	`);
	const publicPresent = Boolean(hasPublic.rows[0]?.present);
	const hasRagActive = await client.query(`
		SELECT to_regclass('rag.active_document_generations') IS NOT NULL AS present
	`);
	const ragActivePresent = Boolean(hasRagActive.rows[0]?.present);

	const limitSql =
		limit && Number.isFinite(limit)
			? `LIMIT ${Math.max(1, Math.floor(limit))}`
			: "";

	const rows = await client.query(
		`
		SELECT
			document.id,
			document.organization_id,
			document.workspace_id,
			document.library_id,
			document.rag_document_id,
			document.filename,
			document.status,
			document.desired_version_id,
			library.rag_library_id,
			(
				SELECT count(*)::int
				FROM app.document_versions AS version
				WHERE version.document_id = document.id
			) AS version_count,
			active.version_id AS active_version_id
			${
				publicPresent
					? `,
			public_document.storage_key AS public_storage_key,
			public_document.content_hash AS public_content_hash,
			public_document.size_bytes AS public_size_bytes`
					: `,
			NULL::text AS public_storage_key,
			NULL::text AS public_content_hash,
			NULL::int AS public_size_bytes`
			}
		FROM app.documents AS document
		JOIN app.libraries AS library ON library.id = document.library_id
		LEFT JOIN app.document_active_versions AS active
			ON active.document_id = document.id
		${
			publicPresent
				? `LEFT JOIN public.documents AS public_document
			ON public_document.id = document.rag_document_id
			AND public_document.library_id = library.rag_library_id`
				: ""
		}
		WHERE document.status NOT IN ('deleted')
		  AND (
			document.desired_version_id IS NULL
			OR NOT EXISTS (
				SELECT 1 FROM app.document_versions AS version
				WHERE version.document_id = document.id
			)
			OR (
				document.status IN ('ready', 'degraded')
				AND active.version_id IS NULL
			)
		  )
		ORDER BY document.updated_at
		${limitSql}
		`,
	);

	summary.scanned = rows.rowCount;

	for (const row of rows.rows) {
		try {
			const needsVersion = Number(row.version_count) === 0;
			const needsDesired = !row.desired_version_id;
			const needsActive =
				["ready", "degraded"].includes(row.status) && !row.active_version_id;
			if (!needsVersion && !needsDesired && !needsActive) {
				summary.already_ok += 1;
				continue;
			}

			let resolvedVersionId = row.desired_version_id;
			let resolvedGenerationId = null;
			let storageKey =
				(row.public_storage_key && String(row.public_storage_key).trim()) || "";
			let contentHash =
				(row.public_content_hash && String(row.public_content_hash).trim()) ||
				"";
			let sizeBytes = row.public_size_bytes;

			if (!needsVersion) {
				const existing = await client.query(
					`
					SELECT id, generation_id, storage_key, content_hash, size_bytes, status
					FROM app.document_versions
					WHERE document_id = $1
					ORDER BY version DESC
					LIMIT 1
					`,
					[row.id],
				);
				const version = existing.rows[0];
				if (!version) {
					throw new Error(
						`document ${row.id} reported versions but none found`,
					);
				}
				resolvedVersionId = version.id;
				resolvedGenerationId = version.generation_id;
				storageKey = storageKey || String(version.storage_key || "");
				contentHash = contentHash || String(version.content_hash || "");
				sizeBytes = sizeBytes ?? version.size_bytes;
			}

			const missingStorage =
				!storageKey || storageKey.startsWith("legacy-missing/");
			if (missingStorage) summary.missing_storage += 1;

			const canActivate =
				needsActive &&
				!missingStorage &&
				["ready", "degraded"].includes(row.status);

			if (needsVersion) summary.would_create_version += 1;
			if (needsDesired || needsVersion) summary.would_set_desired += 1;
			if (canActivate) summary.would_activate += 1;

			if (!apply) continue;

			await client.query("BEGIN");

			if (needsVersion) {
				const versionId = randomUUID();
				const generationId = randomUUID();
				const finalStorageKey =
					storageKey ||
					`legacy-missing/${row.rag_library_id}/${row.rag_document_id}`;
				const finalContentHash =
					contentHash || `legacy:sha256:unknown:${row.rag_document_id}`;
				const versionStatus = canActivate
					? "active"
					: missingStorage
						? "failed"
						: row.status === "processing"
							? "processing"
							: "indexed";
				await client.query(
					`
					INSERT INTO app.document_versions (
						id, document_id, version, generation_id, content_hash,
						storage_key, size_bytes, status, pipeline_version,
						failure_code, error, indexed_at, activated_at,
						created_at, updated_at
					) VALUES (
						$1, $2, 1, $3, $4,
						$5, $6, $7, 'legacy-backfill',
						$8, $9, $10, $11,
						now(), now()
					)
					`,
					[
						versionId,
						row.id,
						generationId,
						finalContentHash,
						finalStorageKey,
						sizeBytes,
						versionStatus,
						missingStorage ? "legacy_missing_storage" : null,
						missingStorage
							? "backfill placeholder; restore object then control-plane reindex"
							: null,
						["indexed", "active"].includes(versionStatus) ? new Date() : null,
						versionStatus === "active" ? new Date() : null,
					],
				);
				resolvedVersionId = versionId;
				resolvedGenerationId = generationId;
			}

			if (resolvedVersionId && (needsDesired || needsVersion)) {
				await client.query(
					`
					UPDATE app.documents
					SET desired_version_id = $2,
					    updated_at = now()
					WHERE id = $1
					`,
					[row.id, resolvedVersionId],
				);
			}

			if (canActivate && resolvedVersionId && resolvedGenerationId) {
				await client.query(
					`
					INSERT INTO app.document_active_versions (document_id, version_id, activated_at)
					VALUES ($1, $2, now())
					ON CONFLICT (document_id) DO UPDATE
					SET version_id = excluded.version_id,
					    activated_at = excluded.activated_at
					`,
					[row.id, resolvedVersionId],
				);
				await client.query(
					`
					UPDATE app.document_versions
					SET status = 'active',
					    activated_at = coalesce(activated_at, now()),
					    updated_at = now()
					WHERE id = $1
					`,
					[resolvedVersionId],
				);
				if (ragActivePresent) {
					await client.query(
						`
						INSERT INTO rag.active_document_generations (
							organization_id, workspace_id, library_id, rag_library_id,
							document_id, document_version_id, generation_id, activated_at
						) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
						ON CONFLICT (organization_id, workspace_id, document_id) DO UPDATE
						SET document_version_id = excluded.document_version_id,
						    generation_id = excluded.generation_id,
						    library_id = excluded.library_id,
						    rag_library_id = excluded.rag_library_id,
						    activated_at = excluded.activated_at
						`,
						[
							row.organization_id,
							row.workspace_id,
							row.library_id,
							row.rag_library_id,
							row.id,
							resolvedVersionId,
							resolvedGenerationId,
						],
					);
				}
			}

			await client.query("COMMIT");
			summary.applied += 1;
		} catch (error) {
			await client.query("ROLLBACK").catch(() => {});
			summary.errors.push({
				document_id: row.id,
				rag_document_id: row.rag_document_id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
} finally {
	await client.end();
}

console.log(JSON.stringify(summary, null, 2));
if (summary.errors.length > 0) process.exit(2);
if (!apply) {
	console.error(
		"dry-run only; re-run with --apply to write versions/active pointers",
	);
}
