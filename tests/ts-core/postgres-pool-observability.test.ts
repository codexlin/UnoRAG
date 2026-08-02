import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { observePostgresPoolErrors } from "../../src/db/pool-observability";

test("postgres pool errors are observed without leaking connection details", () => {
	const pool = new EventEmitter();
	const writes: string[] = [];
	const originalWrite = process.stderr.write;
	process.stderr.write = ((chunk: string) => {
		writes.push(chunk);
		return true;
	}) as typeof process.stderr.write;
	try {
		observePostgresPoolErrors(pool as never, "web");
		const error = Object.assign(
			new Error("password secret-value connection terminated"),
			{ code: "57P01" },
		);
		assert.doesNotThrow(() => pool.emit("error", error));
	} finally {
		process.stderr.write = originalWrite;
	}

	assert.equal(writes.length, 1);
	assert.deepEqual(JSON.parse(writes[0] ?? "{}"), {
		event: "postgres.pool.error",
		component: "web",
		code: "57P01",
	});
	assert.equal(writes[0]?.includes("secret-value"), false);
});
