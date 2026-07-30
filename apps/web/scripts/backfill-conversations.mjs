#!/usr/bin/env node
/**
 * One-way migration from the legacy public.threads/public.turns archive into
 * the scoped app conversation model. Dry-run is the default.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... pnpm conversations:backfill
 *   DATABASE_URL=postgresql://... pnpm conversations:backfill:apply
 */
import { createHash } from "node:crypto";

import pg from "pg";

const apply = process.argv.includes("--apply");
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
	console.error("DATABASE_URL is required");
	process.exit(1);
}

function deterministicUuid(value) {
	const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isUuid(value) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		value,
	);
}

function parseJson(value, fallback) {
	if (typeof value !== "string" || !value.trim()) return fallback;
	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}

function assistantDebug(turn) {
	return {
		mode: turn.mode,
		refused: Boolean(turn.refused),
		refuse_reason: turn.refuse_reason,
		query_type: turn.query_type,
		rewrite: turn.rewrite,
		rewritten_query: turn.rewritten_query,
		judge: parseJson(turn.judge_json, null),
		retrieval_plan: parseJson(turn.retrieval_plan_json, null),
		retrieval_debug: parseJson(turn.retrieval_debug_json, null),
		document_version_id: turn.document_version_id,
		legacy_turn_id: turn.id,
	};
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

const summary = {
	mode: apply ? "apply" : "dry-run",
	legacy_threads: 0,
	eligible_threads: 0,
	skipped_invalid_scope: 0,
	skipped_missing_library: 0,
	threads_inserted: 0,
	turns_inserted: 0,
	already_present: 0,
	errors: [],
};

try {
	const relations = await client.query(`
		SELECT
			to_regclass('public.threads') IS NOT NULL AS threads_present,
			to_regclass('public.turns') IS NOT NULL AS turns_present
	`);
	if (
		!relations.rows[0]?.threads_present ||
		!relations.rows[0]?.turns_present
	) {
		throw new Error(
			"legacy public.threads/public.turns tables are unavailable",
		);
	}

	const counts = await client.query(`
		SELECT
			count(*)::int AS total,
			count(*) FILTER (
				WHERE organization.id IS NOT NULL
				  AND workspace.id IS NOT NULL
				  AND principal.id IS NOT NULL
				  AND member.user_id IS NOT NULL
			)::int AS eligible
		FROM public.threads AS legacy
		LEFT JOIN app.organizations AS organization
			ON organization.id::text = legacy.tenant_id
		LEFT JOIN app.workspaces AS workspace
			ON workspace.id::text = legacy.workspace_id
			AND workspace.organization_id = organization.id
		LEFT JOIN app.users AS principal
			ON principal.id::text = legacy.principal_id
			AND principal.organization_id = organization.id
		LEFT JOIN app.workspace_members AS member
			ON member.workspace_id = workspace.id
			AND member.user_id = principal.id
	`);
	summary.legacy_threads = counts.rows[0]?.total ?? 0;
	summary.eligible_threads = counts.rows[0]?.eligible ?? 0;
	summary.skipped_invalid_scope =
		summary.legacy_threads - summary.eligible_threads;

	const threads = await client.query(`
		SELECT
			legacy.*,
			organization.id AS organization_uuid,
			workspace.id AS workspace_uuid,
			principal.id AS principal_uuid,
			library.rag_library_id AS resolved_library_id
		FROM public.threads AS legacy
		JOIN app.organizations AS organization
			ON organization.id::text = legacy.tenant_id
		JOIN app.workspaces AS workspace
			ON workspace.id::text = legacy.workspace_id
			AND workspace.organization_id = organization.id
		JOIN app.users AS principal
			ON principal.id::text = legacy.principal_id
			AND principal.organization_id = organization.id
		JOIN app.workspace_members AS member
			ON member.workspace_id = workspace.id
			AND member.user_id = principal.id
		LEFT JOIN app.libraries AS library
			ON library.organization_id = organization.id
			AND library.workspace_id = workspace.id
			AND library.rag_library_id = legacy.library_id
		ORDER BY legacy.created_at, legacy.id
	`);

	for (const thread of threads.rows) {
		if (thread.library_id && !thread.resolved_library_id) {
			summary.skipped_missing_library += 1;
			continue;
		}

		const targetThreadId = isUuid(thread.id)
			? thread.id
			: deterministicUuid(`unorag:legacy-thread:${thread.id}`);
		const turns = await client.query(
			`
			SELECT *
			FROM public.turns
			WHERE thread_id = $1
			ORDER BY created_at, id
			`,
			[thread.id],
		);

		if (!apply) {
			const existing = await client.query(
				"SELECT 1 FROM app.threads WHERE id = $1",
				[targetThreadId],
			);
			if (existing.rowCount) {
				summary.already_present += 1;
			} else {
				summary.threads_inserted += 1;
				summary.turns_inserted += turns.rowCount * 2;
			}
			continue;
		}

		await client.query("BEGIN");
		try {
			const insertedThread = await client.query(
				`
				INSERT INTO app.threads (
					id, organization_id, workspace_id, principal_id, session_id,
					rag_library_id, title, status, created_at, updated_at
				) VALUES (
					$1, $2, $3, $4, $5,
					$6, $7, $8, $9, $10
				)
				ON CONFLICT (id) DO NOTHING
				RETURNING id
				`,
				[
					targetThreadId,
					thread.organization_uuid,
					thread.workspace_uuid,
					thread.principal_uuid,
					thread.session_id,
					thread.resolved_library_id,
					thread.title || "未命名会话",
					thread.status === "active" ? "active" : "hidden",
					thread.created_at,
					thread.updated_at,
				],
			);
			if (insertedThread.rowCount) {
				summary.threads_inserted += 1;
			} else {
				summary.already_present += 1;
			}

			for (const [index, turn] of turns.rows.entries()) {
				const userId = deterministicUuid(`unorag:legacy-turn:${turn.id}:user`);
				const assistantId = isUuid(turn.id)
					? turn.id
					: deterministicUuid(`unorag:legacy-turn:${turn.id}:assistant`);
				const values = [
					[userId, index * 2 + 1, "user", turn.question, [], null],
					[
						assistantId,
						index * 2 + 2,
						"assistant",
						turn.answer,
						parseJson(turn.citations_json, []),
						assistantDebug(turn),
					],
				];
				for (const [id, sequence, role, content, citations, debug] of values) {
					const insertedTurn = await client.query(
						`
						INSERT INTO app.turns (
							id, thread_id, organization_id, workspace_id, principal_id,
							sequence, role, content, citations, debug, status,
							created_at, updated_at
						) VALUES (
							$1, $2, $3, $4, $5,
							$6, $7, $8, $9::jsonb, $10::jsonb, 'complete',
							$11, $11
						)
						ON CONFLICT (id) DO NOTHING
						RETURNING id
						`,
						[
							id,
							targetThreadId,
							thread.organization_uuid,
							thread.workspace_uuid,
							thread.principal_uuid,
							sequence,
							role,
							content,
							JSON.stringify(citations),
							debug === null ? null : JSON.stringify(debug),
							turn.created_at,
						],
					);
					summary.turns_inserted += insertedTurn.rowCount;
				}
			}
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		}
	}
} catch (error) {
	summary.errors.push(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	await client.end();
	console.log(JSON.stringify(summary, null, 2));
}
