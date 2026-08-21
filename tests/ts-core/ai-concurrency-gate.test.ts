import assert from "node:assert/strict";
import test from "node:test";

import type { LanguageModel } from "ai";

import {
	AiConcurrencyGate,
	AiConcurrencyOverloadedError,
	AiConcurrencyWaitTimeoutError,
	AnswerStreamAbortedError,
	AnswerStreamAdapter,
	StructuredOutputAdapter,
} from "../../src/core/ai";

const model = {} as LanguageModel;

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

test("AI concurrency gate is FIFO and never exceeds its limit", async () => {
	const gate = new AiConcurrencyGate(1);
	const first = await gate.acquire();
	const order: number[] = [];
	const secondPromise = gate.acquire().then((lease) => {
		order.push(2);
		return lease;
	});
	const thirdPromise = gate.acquire().then((lease) => {
		order.push(3);
		return lease;
	});

	assert.deepEqual(gate.snapshot(), { active: 1, queued: 2, limit: 1 });
	first.release();
	const second = await secondPromise;
	assert.deepEqual(order, [2]);
	assert.deepEqual(gate.snapshot(), { active: 1, queued: 1, limit: 1 });
	second.release();
	const third = await thirdPromise;
	assert.deepEqual(order, [2, 3]);
	third.release();
	assert.deepEqual(gate.snapshot(), { active: 0, queued: 0, limit: 1 });
});

test("aborted waiters leave the queue without consuming a permit", async () => {
	const events: string[] = [];
	const gate = new AiConcurrencyGate(1, (event) => {
		if (event.type === "acquire") events.push(event.outcome);
	});
	const first = await gate.acquire();
	const controller = new AbortController();
	const queued = gate.acquire(controller.signal);
	controller.abort(new Error("client disconnected"));

	await assert.rejects(queued, /client disconnected/);
	assert.deepEqual(gate.snapshot(), { active: 1, queued: 0, limit: 1 });
	first.release();
	assert.deepEqual(events, ["acquired", "cancelled"]);
});

test("AI concurrency gate bounds its queue and times out stale waiters", async () => {
	const gate = new AiConcurrencyGate(1, undefined, {
		maxQueue: 1,
		waitTimeoutMs: 5,
	});
	const held = await gate.acquire();
	const stale = gate.acquire();
	await assert.rejects(
		gate.acquire(),
		(error) => error instanceof AiConcurrencyOverloadedError,
	);
	await assert.rejects(
		stale,
		(error) =>
			error instanceof AiConcurrencyWaitTimeoutError && error.timeoutMs === 5,
	);
	assert.deepEqual(gate.snapshot(), { active: 1, queued: 0, limit: 1 });
	held.release();
});

test("telemetry failures cannot leak permits or block queued callers", async () => {
	const gate = new AiConcurrencyGate(1, () => {
		throw new Error("telemetry unavailable");
	});
	const first = await gate.acquire();
	const secondPromise = gate.acquire();
	first.release();
	const second = await secondPromise;
	second.release();
	assert.equal(gate.snapshot().active, 0);
});

test("structured provider timeout starts after concurrency admission", async () => {
	const gate = new AiConcurrencyGate(1, undefined, { waitTimeoutMs: 100 });
	const held = await gate.acquire();
	const adapter = new StructuredOutputAdapter(
		model,
		async () => ({ query_type: "fact", reason: "supported" }),
		{ concurrencyGate: gate, maxAttempts: 1, timeoutMs: 10 },
	);

	const queued = adapter.route({ question: "What is covered?" });
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.deepEqual(gate.snapshot(), { active: 1, queued: 1, limit: 1 });
	held.release();

	assert.deepEqual(await queued, {
		query_type: "fact",
		reason: "supported",
	});
	assert.deepEqual(gate.snapshot(), { active: 0, queued: 0, limit: 1 });
});

test("answer streams hold a permit until completion and normalize cancellation", async () => {
	const gate = new AiConcurrencyGate(1);
	const continueStream = deferred<void>();
	const adapter = new AnswerStreamAdapter(
		model,
		async function* () {
			yield "first";
			await continueStream.promise;
			yield "second";
		},
		{ concurrencyGate: gate },
	);
	const iterator = adapter.stream({ question: "q", context: "c" });
	assert.deepEqual(await iterator.next(), { value: "first", done: false });
	assert.equal(gate.snapshot().active, 1);

	const waiting = gate.acquire();
	assert.equal(gate.snapshot().queued, 1);
	continueStream.resolve();
	assert.deepEqual(await iterator.next(), { value: "second", done: false });
	assert.deepEqual(await iterator.next(), { value: undefined, done: true });
	const lease = await waiting;
	lease.release();

	const controller = new AbortController();
	const held = await gate.acquire();
	const cancelled = adapter
		.stream({ question: "q", context: "c" }, { abortSignal: controller.signal })
		.next();
	controller.abort();
	await assert.rejects(
		cancelled,
		(error) => error instanceof AnswerStreamAbortedError,
	);
	held.release();
});
