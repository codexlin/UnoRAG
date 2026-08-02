import "server-only";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { observePostgresPoolErrors } from "./pool-observability";
import * as schema from "./schema";

const globalForDatabase = globalThis as typeof globalThis & {
	unoragPool?: Pool;
};

function createPool(): Pool {
	const connectionString = process.env.DATABASE_URL?.trim();
	if (!connectionString) {
		throw new Error("DATABASE_URL is required for the Next.js control plane");
	}
	return observePostgresPoolErrors(
		new Pool({
			connectionString,
			max: Number(process.env.DATABASE_POOL_MAX ?? 10),
			idleTimeoutMillis: 30_000,
			connectionTimeoutMillis: 5_000,
		}),
		"web",
	);
}

export function getDatabase() {
	const pool = globalForDatabase.unoragPool ?? createPool();
	globalForDatabase.unoragPool = pool;
	return drizzle(pool, { schema });
}
