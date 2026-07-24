import { existsSync } from "node:fs";

import pg from "pg";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

function option(name) {
	const prefix = `--${name}=`;
	return process.argv
		.find((argument) => argument.startsWith(prefix))
		?.slice(prefix.length);
}

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL?.trim();
const eventId = option("event-id")?.trim();
const eventType = option("event-type")?.trim();
const requestedLimit = Number(option("limit") ?? 100);
const limit = Math.max(1, Math.min(1000, requestedLimit || 100));

if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!eventId && !eventType) {
	throw new Error(
		"select dead events with --event-id=<uuid> or --event-type=<type>",
	);
}

const filters = ["status = 'dead'"];
const parameters = [];
if (eventId) {
	parameters.push(eventId);
	filters.push(`id = $${parameters.length}`);
}
if (eventType) {
	parameters.push(eventType);
	filters.push(`event_type = $${parameters.length}`);
}
parameters.push(limit);
const limitParameter = `$${parameters.length}`;

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
	const result = await client.query(
		`
			WITH selected AS (
				SELECT id
				FROM app.outbox_events
				WHERE ${filters.join(" AND ")}
				ORDER BY updated_at
				FOR UPDATE SKIP LOCKED
				LIMIT ${limitParameter}
			)
			UPDATE app.outbox_events AS event
			SET status = 'pending',
				attempts = 0,
				available_at = now(),
				locked_by = NULL,
				locked_at = NULL,
				processed_at = NULL,
				updated_at = now()
			FROM selected
			WHERE event.id = selected.id
			RETURNING event.id, event.event_type, event.aggregate_id
		`,
		parameters,
	);
	console.log(JSON.stringify({ replayed: result.rows }, null, 2));
} finally {
	await client.end();
}
