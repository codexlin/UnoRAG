#!/usr/bin/env node
import process from "node:process";

import pg from "pg";

const { Pool } = pg;

const ACTIVE_APP_STATUSES = ["queued", "retry", "running", "cancelling"];
const ACTIVE_DBOS_STATUSES = ["PENDING", "ENQUEUED", "DELAYED"];

function parseArgs(argv) {
	const options = {
		applicationVersion: "",
		scope: "all",
		timeoutSeconds: 0,
		pollSeconds: 5,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--application-version") {
			options.applicationVersion = argv[++index] ?? "";
		} else if (argument === "--scope") {
			options.scope = argv[++index] ?? "";
		} else if (argument === "--timeout-seconds") {
			options.timeoutSeconds = Number(argv[++index]);
		} else if (argument === "--poll-seconds") {
			options.pollSeconds = Number(argv[++index]);
		} else {
			throw new Error(`unknown argument: ${argument}`);
		}
	}
	if (!new Set(["all", "app", "dbos"]).has(options.scope)) {
		throw new Error("--scope must be all, app, or dbos");
	}
	if (options.scope !== "app" && !options.applicationVersion) {
		throw new Error("--application-version is required for DBOS inspection");
	}
	if (
		!Number.isFinite(options.timeoutSeconds) ||
		options.timeoutSeconds < 0 ||
		!Number.isFinite(options.pollSeconds) ||
		options.pollSeconds <= 0
	) {
		throw new Error("timeout and poll values must be valid positive numbers");
	}
	return options;
}

function total(rows) {
	return rows.reduce((sum, row) => sum + Number(row.count), 0);
}

export function drainSnapshot({
	applicationVersion,
	appRows,
	dbosRows,
	scope,
}) {
	const appActive = scope === "dbos" ? 0 : total(appRows);
	const dbosActive = scope === "app" ? 0 : total(dbosRows);
	return {
		drained: appActive === 0 && dbosActive === 0,
		application_version: applicationVersion || null,
		scope,
		app: { active: appActive, by_status: appRows },
		dbos: { active: dbosActive, by_status: dbosRows },
	};
}

async function inspectOnce({ applicationVersion, appPool, dbosPool, scope }) {
	const appRows =
		scope === "dbos"
			? []
			: (
					await appPool.query(
						`SELECT status, count(*)::int AS count
						 FROM app.jobs
						 WHERE status = ANY($1::text[])
						 GROUP BY status
						 ORDER BY status`,
						[ACTIVE_APP_STATUSES],
					)
				).rows;
	const dbosRows =
		scope === "app"
			? []
			: (
					await dbosPool.query(
						`SELECT status, count(*)::int AS count
						 FROM dbos.workflow_status
						 WHERE status = ANY($1::text[])
						   AND (application_version = $2 OR application_version IS NULL)
						 GROUP BY status
						 ORDER BY status`,
						[ACTIVE_DBOS_STATUSES, applicationVersion],
					)
				).rows;
	return drainSnapshot({ applicationVersion, appRows, dbosRows, scope });
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const databaseUrl = process.env.DATABASE_URL?.trim();
	const dbosDatabaseUrl = process.env.DBOS_SYSTEM_DATABASE_URL?.trim();
	if (options.scope !== "dbos" && !databaseUrl) {
		throw new Error("DATABASE_URL is required");
	}
	if (options.scope !== "app" && !dbosDatabaseUrl) {
		throw new Error("DBOS_SYSTEM_DATABASE_URL is required");
	}

	const appPool = databaseUrl
		? new Pool({ connectionString: databaseUrl, max: 1 })
		: null;
	const dbosPool = dbosDatabaseUrl
		? new Pool({ connectionString: dbosDatabaseUrl, max: 1 })
		: null;
	const deadline = Date.now() + options.timeoutSeconds * 1_000;
	try {
		for (;;) {
			const snapshot = await inspectOnce({
				...options,
				appPool,
				dbosPool,
			});
			console.log(JSON.stringify(snapshot));
			if (snapshot.drained) return;
			if (Date.now() >= deadline) {
				process.exitCode = 75;
				return;
			}
			await new Promise((resolve) =>
				setTimeout(resolve, options.pollSeconds * 1_000),
			);
		}
	} finally {
		await Promise.allSettled([appPool?.end(), dbosPool?.end()]);
	}
}

if (process.argv[1]?.endsWith("check-dbos-drain.mjs")) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
