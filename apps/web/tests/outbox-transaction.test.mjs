import assert from "node:assert/strict";
import test from "node:test";

import { runOutboxMutation } from "../src/lib/server/outbox-transaction.mjs";

function transactionalState(initial) {
	const state = structuredClone(initial);
	return {
		state,
		database: {
			async transaction(callback) {
				const snapshot = structuredClone(state);
				try {
					return await callback(state);
				} catch (error) {
					for (const key of Object.keys(state)) delete state[key];
					Object.assign(state, snapshot);
					throw error;
				}
			},
		},
	};
}

test("business mutation and outbox append commit together", async () => {
	const fixture = transactionalState({ libraries: [], outbox: [] });

	const result = await runOutboxMutation(
		fixture.database,
		async (transaction) => {
			const library = { id: "library-1" };
			transaction.libraries.push(library);
			return library;
		},
		async (transaction, library) => {
			transaction.outbox.push({ aggregate_id: library.id });
		},
	);

	assert.deepEqual(result, { id: "library-1" });
	assert.deepEqual(fixture.state, {
		libraries: [{ id: "library-1" }],
		outbox: [{ aggregate_id: "library-1" }],
	});
});

test("outbox failure rolls back the business mutation", async () => {
	const fixture = transactionalState({ libraries: [], outbox: [] });

	await assert.rejects(
		runOutboxMutation(
			fixture.database,
			async (transaction) => {
				transaction.libraries.push({ id: "library-1" });
				return { id: "library-1" };
			},
			async () => {
				throw new Error("outbox unavailable");
			},
		),
		/outbox unavailable/,
	);

	assert.deepEqual(fixture.state, { libraries: [], outbox: [] });
});
