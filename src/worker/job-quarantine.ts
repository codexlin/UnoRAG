import type { Pool } from "pg";

import { type DurableJobInput, durableJobSchema } from "./contracts";

type DurableJobRow = Record<string, unknown> & { jobId: unknown };

export async function parseOrQuarantineDurableJob(
	pool: Pool,
	row: DurableJobRow,
): Promise<DurableJobInput | null> {
	const parsed = durableJobSchema.safeParse(row);
	if (parsed.success) return parsed.data;

	const jobId = String(row.jobId);
	const details = parsed.error.issues
		.map((issue) => {
			const path = issue.path.length > 0 ? issue.path.join(".") : "job";
			return `${path}: ${issue.message}`;
		})
		.join("; ")
		.slice(0, 8_000);
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		// Cleanup workflows lock queue state before app.jobs. Preserve that order
		// here so malformed payload quarantine cannot deadlock normal completion.
		await client.query(
			`
				SELECT generation_id
				FROM app.generation_cleanup_queue
				WHERE cleanup_job_id = $1
				FOR UPDATE
			`,
			[jobId],
		);
		const quarantined = await client.query<{ type: string }>(
			`
				UPDATE app.jobs
				SET status = 'dead',
					stage = 'done',
					error_code = 'dbos_job_payload_invalid',
					error = $2,
					finished_at = coalesce(finished_at, now()),
					dispatched_at = coalesce(dispatched_at, now()),
					updated_at = now()
				WHERE id = $1
				  AND execution_engine = 'dbos'
				  AND status <> 'completed'
				RETURNING type
			`,
			[jobId, details],
		);
		if (quarantined.rows[0]?.type === "generation.cleanup") {
			await client.query(
				`
					UPDATE app.generation_cleanup_queue
					SET sweep_status = 'error',
						sweep_last_error = $2,
						sweep_updated_at = now(),
						updated_at = now()
					WHERE cleanup_job_id = $1
					  AND sweep_status IN ('pending', 'sweeping')
				`,
				[jobId, details],
			);
		}
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK").catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
	return null;
}
