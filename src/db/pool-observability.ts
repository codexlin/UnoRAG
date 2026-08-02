import type { Pool } from "pg";

type PostgresError = Error & { code?: string };

export function observePostgresPoolErrors(pool: Pool, component: string): Pool {
	pool.on("error", (error: PostgresError) => {
		process.stderr.write(
			`${JSON.stringify({
				event: "postgres.pool.error",
				component,
				code: error.code ?? "unknown",
			})}\n`,
		);
	});
	return pool;
}
