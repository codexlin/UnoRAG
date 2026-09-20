import type { Pool } from "pg";

export async function closeGlobalDatabasePool(): Promise<void> {
	const state = globalThis as typeof globalThis & { unoragPool?: Pool };
	const pool = state.unoragPool;
	delete state.unoragPool;
	if (pool) await pool.end();
}
