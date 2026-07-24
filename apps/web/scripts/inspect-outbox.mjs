import { existsSync } from "node:fs";

import pg from "pg";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL?.trim();
const failOnDead = process.argv.includes("--fail-on-dead");
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
	const summary = await client.query(`
		SELECT
			status,
			event_type,
			count(*)::int AS count,
			min(created_at) AS oldest_created_at,
			max(attempts)::int AS max_attempts
		FROM app.outbox_events
		WHERE status IN ('pending', 'retry', 'processing', 'dead')
		GROUP BY status, event_type
		ORDER BY
			CASE status
				WHEN 'dead' THEN 0
				WHEN 'processing' THEN 1
				WHEN 'retry' THEN 2
				ELSE 3
			END,
			event_type
	`);
	const dead = await client.query(`
		SELECT
			id,
			event_type,
			aggregate_id,
			attempts,
			created_at,
			updated_at,
			last_error
		FROM app.outbox_events
		WHERE status = 'dead'
		ORDER BY updated_at
		LIMIT 20
	`);

	console.log(
		JSON.stringify({ summary: summary.rows, dead: dead.rows }, null, 2),
	);
	if (failOnDead && dead.rowCount > 0) process.exitCode = 2;
} finally {
	await client.end();
}
