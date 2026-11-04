import { ProductSession } from "./recovery-probe.mjs";

/** @returns {Pick<ProductSession, "request">} */
function createProductSession(baseUrl) {
	return new ProductSession(baseUrl);
}

// Only product deletion may remove source objects and vector projections. SQL
// teardown is allowed after all fixture lifecycle work has reached its terminal state.
export async function cleanupIsolationTopology({
	client,
	organizationIds,
	owners,
	baseUrl,
	password,
	timeoutMs = 300_000,
	pollMs = 1_000,
	createSession = createProductSession,
}) {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
		throw new Error("isolation cleanup timeout must be positive");
	const { rows: libraries } = await client.query(
		`SELECT rag_library_id, workspace_id FROM app.libraries
		 WHERE organization_id = ANY($1::uuid[]) AND status <> 'deleted'`,
		[organizationIds],
	);
	const sessions = new Map();
	for (const library of libraries) {
		const owner = owners.find(
			(user) => user.workspace === library.workspace_id,
		);
		if (!owner) throw new Error("fixture library has no cleanup owner");
		let session = sessions.get(owner.workspace);
		if (!session) {
			session = createSession(baseUrl);
			await session.request("/api/auth/session", {
				method: "POST",
				body: { email: owner.email, password, workspace_id: owner.workspace },
			});
			sessions.set(owner.workspace, session);
		}
		await session.request(`/api/libraries/${library.rag_library_id}`, {
			method: "DELETE",
			expected: [200, 202, 204, 404],
		});
	}

	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const state = await readCleanupState(client, organizationIds);
		if (state.failed_deletes > 0)
			throw new Error("fixture document deletion failed; topology retained");
		if (Object.values(state).every((value) => value === 0)) break;
		if (Date.now() >= deadline)
			throw new Error("fixture cleanup timed out; topology retained");
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}

	await client.query("BEGIN");
	try {
		await client.query("SET LOCAL lock_timeout = '5s'");
		// Lock the FK parents before the final check so a new fixture write cannot
		// race the cascade after the cleanup snapshot.
		await client.query(
			"SELECT id FROM app.organizations WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
			[organizationIds],
		);
		const state = await readCleanupState(client, organizationIds);
		if (Object.values(state).some((value) => value !== 0))
			throw new Error(
				"fixture lifecycle changed during cleanup; topology retained",
			);
		await client.query(
			"DELETE FROM app.organizations WHERE id = ANY($1::uuid[])",
			[organizationIds],
		);
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	}
	return { libraries_requested: libraries.length, status: "passed" };
}

async function readCleanupState(client, organizationIds) {
	const { rows } = await client.query(
		`SELECT
		 (SELECT count(*) FROM app.libraries WHERE organization_id = ANY($1::uuid[])
		  AND status <> 'deleted')::integer AS live_libraries,
		 (SELECT count(*) FROM app.documents WHERE organization_id = ANY($1::uuid[])
		  AND status <> 'deleted')::integer AS live_documents,
		 (SELECT count(*) FROM app.jobs WHERE organization_id = ANY($1::uuid[])
		  AND status NOT IN ('completed', 'failed', 'dead', 'cancelled'))::integer AS pending_jobs,
		 (SELECT count(*) FROM app.jobs AS job
		  JOIN app.documents AS document ON document.latest_job_id = job.id
		  WHERE job.organization_id = ANY($1::uuid[]) AND document.status <> 'deleted'
		  AND job.type = 'document.delete' AND job.status IN ('failed', 'dead', 'cancelled'))::integer AS failed_deletes,
		 (SELECT count(*) FROM app.generation_cleanup_queue WHERE organization_id = ANY($1::uuid[])
		  AND sweep_status <> 'deleted')::integer AS pending_generations`,
		[organizationIds],
	);
	if (!rows[0]) throw new Error("fixture cleanup state is unavailable");
	return rows[0];
}
