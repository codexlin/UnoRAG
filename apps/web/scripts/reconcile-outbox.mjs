import { existsSync } from "node:fs";

import pg from "pg";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL?.trim();
const libraryId = process.argv
	.find((argument) => argument.startsWith("--library-id="))
	?.slice("--library-id=".length)
	.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
	const result = await client.query(
		`
		WITH library_snapshot AS MATERIALIZED (
			SELECT library.*
			FROM app.libraries AS library
			WHERE ($1::varchar IS NULL OR library.rag_library_id = $1)
			FOR UPDATE
		)
		INSERT INTO app.outbox_events (
			organization_id,
			workspace_id,
			aggregate_type,
			aggregate_id,
			event_type,
			idempotency_key,
			payload
		)
		SELECT
			library.organization_id,
			library.workspace_id,
			'library',
			library.rag_library_id,
			'library.upsert',
			'library.reconcile:' || library.id::text || ':' ||
				(extract(epoch FROM library.updated_at) * 1000000)::bigint::text,
			jsonb_build_object(
				'library_id', library.rag_library_id,
				'name', library.name,
				'description', library.description,
				'principal_id', COALESCE(library.created_by::text, 'outbox-reconcile')
			)
		FROM library_snapshot AS library
		ON CONFLICT (idempotency_key) DO UPDATE
		SET status = 'pending',
			attempts = 0,
			available_at = now(),
			locked_by = NULL,
			locked_at = NULL,
			last_error = NULL,
			processed_at = NULL,
			payload = EXCLUDED.payload,
			updated_at = now()
		WHERE app.outbox_events.status = 'dead'
		RETURNING id
	`,
		[libraryId || null],
	);
	console.log(`enqueued ${result.rowCount} reconciliation event(s)`);
} finally {
	await client.end();
}
