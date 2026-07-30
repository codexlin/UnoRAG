import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { parseOrQuarantineDurableJob } from "../../src/worker/job-quarantine";

const validJob = {
	jobId: "30000000-0000-4000-8000-000000000001",
	organizationId: "10000000-0000-4000-8000-000000000002",
	workspaceId: "10000000-0000-4000-8000-000000000003",
	idempotencyKey: "document.delete:test",
	type: "document.delete",
	payload: {
		document_id: "10000000-0000-4000-8000-000000000004",
		rag_document_id: "rag-document",
		library_id: "10000000-0000-4000-8000-000000000007",
		rag_library_id: "rag-library",
		storage_keys: [],
		generation_ids: [],
		library_delete: false,
	},
};

test("valid durable jobs pass without touching PostgreSQL", async () => {
	const pool = {
		async query() {
			throw new Error("valid jobs must not be quarantined");
		},
	} as unknown as Pool;

	assert.deepEqual(await parseOrQuarantineDurableJob(pool, validJob), validJob);
});

test("invalid durable jobs are quarantined with a bounded validation error", async () => {
	const queries: Array<{ text: string; values: unknown[] | undefined }> = [];
	const client = {
		async query(text: string, values?: unknown[]) {
			queries.push({ text, values });
			if (/RETURNING type/.test(text)) {
				return { rowCount: 1, rows: [{ type: "document.delete" }] };
			}
			return { rowCount: 1, rows: [] };
		},
		release() {},
	};
	const pool = {
		async connect() {
			return client;
		},
	} as unknown as Pool;

	assert.equal(
		await parseOrQuarantineDurableJob(pool, {
			...validJob,
			payload: { ...validJob.payload, rag_document_id: undefined },
		}),
		null,
	);
	assert.equal(queries.length, 4);
	assert.equal(queries[0].text, "BEGIN");
	assert.match(queries[1].text, /generation_cleanup_queue/);
	assert.match(queries[1].text, /FOR UPDATE/);
	assert.match(queries[2].text, /dbos_job_payload_invalid/);
	assert.equal(queries[2].values?.[0], validJob.jobId);
	assert.match(String(queries[2].values?.[1]), /payload\.rag_document_id/);
	assert.ok(String(queries[2].values?.[1]).length <= 8_000);
	assert.equal(queries[3].text, "COMMIT");
});

test("a terminalization race still excludes the invalid job from dispatch", async () => {
	const client = {
		async query(text: string) {
			if (/RETURNING type/.test(text)) {
				return { rowCount: 0, rows: [] };
			}
			return { rowCount: 0, rows: [] };
		},
		release() {},
	};
	const pool = {
		async connect() {
			return client;
		},
	} as unknown as Pool;

	assert.equal(
		await parseOrQuarantineDurableJob(pool, {
			...validJob,
			payload: {},
		}),
		null,
	);
});
