import assert from "node:assert/strict";
import test from "node:test";

import { isCancelledError, QueryClient } from "@tanstack/react-query";

import {
	HealthProbeError,
	resolveHealthQueryState,
	runTimedHealthProbe,
} from "../../src/lib/health-query-state";
import {
	fetchBackgroundQuery,
	fetchFreshQuery,
} from "../../src/lib/query-refresh";

test("background polls join the post-mutation refresh without cancelling it", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const key = ["libraries", "organization", "workspace"] as const;
	let finish!: (rows: string[]) => void;
	let started!: () => void;
	const waiting = new Promise<void>((resolve) => {
		started = resolve;
	});
	let refreshSignal: AbortSignal | undefined;
	const result = new Promise<string[]>((resolve) => {
		finish = resolve;
	});
	const authoritative = fetchFreshQuery(client, key, async ({ signal }) => {
		refreshSignal = signal;
		started();
		return result;
	});
	await waiting;
	let pollExecuted = false;
	const poll = fetchBackgroundQuery(client, key, async () => {
		pollExecuted = true;
		return ["old"];
	});
	finish(["new"]);
	assert.deepEqual(await authoritative, ["new"]);
	assert.deepEqual(await poll, ["new"]);
	assert.deepEqual(client.getQueryData(key), ["new"]);
	assert.equal(pollExecuted, false);
	assert.equal(refreshSignal?.aborted, false);
	client.clear();
});

test("fetchFreshQuery cancels an in-flight pre-mutation snapshot", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const queryKey = ["libraries", "organization", "workspace"] as const;
	let markStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});

	const oldRequest = client.fetchQuery({
		queryKey,
		queryFn: ({ signal }) =>
			new Promise<string[]>((_resolve, reject) => {
				markStarted?.();
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			}),
	});
	await started;

	const fresh = await fetchFreshQuery(client, queryKey, async () => ["new"]);
	assert.deepEqual(fresh, ["new"]);
	assert.deepEqual(client.getQueryData(queryKey), ["new"]);
	await assert.rejects(oldRequest, (error) => isCancelledError(error));
	client.clear();
});

test("a failed health probe never treats retained successful data as ready", () => {
	const previous = {
		payload: { status: "ok" },
		probedAt: 100,
		probeMs: 4,
	};
	const error = new HealthProbeError("offline", 200, 9);
	const state = resolveHealthQueryState({
		data: previous,
		error,
		isAvailable: (health) => health.status === "ok",
	});

	assert.deepEqual(state.health, previous.payload);
	assert.equal(state.error, "offline");
	assert.equal(state.apiReady, false);
	assert.equal(state.healthProbedAt, 200);
	assert.equal(state.healthProbeMs, 9);
});

test("timed health failures retain attempt metadata and the original cause", async () => {
	const cause = new Error("connection refused");
	await assert.rejects(
		runTimedHealthProbe(async () => {
			throw cause;
		}),
		(error) => {
			assert.ok(error instanceof HealthProbeError);
			assert.equal(error.message, cause.message);
			assert.equal(error.cause, cause);
			assert.ok(error.probedAt > 0);
			assert.ok(error.probeMs >= 0);
			return true;
		},
	);
});

test("timed health probes preserve abort identity for retry policy", async () => {
	const cause = new DOMException("cancelled", "AbortError");
	await assert.rejects(
		runTimedHealthProbe(async () => {
			throw cause;
		}),
		(error) => {
			assert.ok(error instanceof HealthProbeError);
			assert.equal(error.name, "AbortError");
			assert.equal(error.cause, cause);
			return true;
		},
	);
});
