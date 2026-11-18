import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import type { ApiLibrary } from "../../src/lib/api";
import {
	libraryRefetchInterval,
	seedAcceptedLibraryDeletion,
} from "../../src/lib/library-query-state";
import { queryKeys } from "../../src/lib/query-keys";
import {
	fetchBackgroundQuery,
	fetchFreshQuery,
} from "../../src/lib/query-refresh";

const scope = { organizationId: "org", workspaceId: "workspace-a" };
const library: ApiLibrary = {
	id: "library-a",
	name: "Example",
	status: "ready",
	doc_count: 1,
	ready_count: 1,
	created_at: "2026-11-18T00:00:00Z",
	updated_at: "2026-11-18T00:00:00Z",
};
const deleting = { ...library, status: "deleting" };
function client() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity } },
	});
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("library polling runs only while the authoritative list contains deleting", () => {
	for (const status of [
		"ready",
		"empty",
		"indexing",
		"degraded",
		"failed",
		"deleted",
		"unknown",
	]) {
		assert.equal(libraryRefetchInterval([{ ...library, status }]), false);
		assert.equal(
			libraryRefetchInterval([{ ...library, status }, deleting]),
			2_000,
		);
	}
	assert.equal(libraryRefetchInterval(undefined), false);
	assert.equal(libraryRefetchInterval([]), false);
});

test("accepted library deletion cancels stale data and preserves rows/counts in its captured workspace", async (t) => {
	const cache = client();
	t.after(() => cache.clear());
	const key = queryKeys.libraries(scope);
	const otherScope = { ...scope, workspaceId: "workspace-b" };
	const otherKey = queryKeys.libraries(otherScope);
	const other = { ...library, id: "library-b" };
	cache.setQueryData(key, [{ ...library, delete_jobs_active: false }, other]);
	cache.setQueryData(otherKey, [library]);
	const stale = deferred<ApiLibrary[]>();
	let oldSignal: AbortSignal | undefined;
	const oldRead = cache.fetchQuery({
		queryKey: key,
		queryFn: ({ signal }) => {
			oldSignal = signal;
			return stale.promise;
		},
	});
	await seedAcceptedLibraryDeletion(cache, scope, library.id);
	assert.equal(oldSignal?.aborted, true);
	stale.resolve([library]);
	// A cancelled query with previous data resolves that snapshot; it cannot commit the late response.
	await oldRead;
	assert.deepEqual(cache.getQueryData(key), [
		{ ...deleting, delete_jobs_active: undefined },
		other,
	]);
	assert.deepEqual(cache.getQueryData(otherKey), [library]);
	assert.equal(libraryRefetchInterval(cache.getQueryData(key)), 2_000);
});

test("inactive delete jobs back off globally and a real retry resumes fast polling", () => {
	const failed = { ...deleting, delete_jobs_active: false };
	assert.equal(libraryRefetchInterval([failed]), 30_000);
	assert.equal(libraryRefetchInterval([failed, library]), 30_000);
	assert.equal(
		libraryRefetchInterval([
			failed,
			{ ...deleting, id: "active", delete_jobs_active: true },
		]),
		2_000,
	);
	assert.equal(
		libraryRefetchInterval([{ ...failed, delete_jobs_active: true }]),
		2_000,
	);
	assert.equal(libraryRefetchInterval([deleting], 2), 4_000);
	assert.equal(libraryRefetchInterval([deleting], 100), 30_000);
	assert.equal(libraryRefetchInterval([], 100), false);
});

test("acceptance refreshes only active document jobs in the same scope and invalidates inactive data", async (t) => {
	const cache = client();
	t.after(() => cache.clear());
	cache.setQueryData(queryKeys.libraries(scope), [library]);
	const key = queryKeys.documents(scope, library.id);
	const otherKey = queryKeys.documents(
		{ ...scope, workspaceId: "workspace-b" },
		library.id,
	);
	cache.setQueryData(key, ["old-ingest"]);
	cache.setQueryData(otherKey, ["unrelated"]);
	const observer = new QueryObserver(cache, {
		queryKey: key,
		staleTime: Infinity,
		queryFn: async () => ["failed-delete-job"],
	});
	const unsubscribe = observer.subscribe(() => {});
	t.after(unsubscribe);
	await seedAcceptedLibraryDeletion(cache, scope, library.id);
	await cache.fetchQuery({ queryKey: key });
	assert.deepEqual(cache.getQueryData(key), ["failed-delete-job"]);
	assert.deepEqual(cache.getQueryData(otherKey), ["unrelated"]);
	assert.equal(cache.getQueryState(otherKey)?.isInvalidated, false);
	unsubscribe();
	await seedAcceptedLibraryDeletion(cache, scope, library.id);
	assert.equal(cache.getQueryState(key)?.isInvalidated, true);
});

test("a failed refresh retains deleting and polling until the server confirms absence", async (t) => {
	const cache = client();
	t.after(() => cache.clear());
	const key = queryKeys.libraries(scope);
	cache.setQueryData(key, [deleting]);
	await assert.rejects(
		fetchBackgroundQuery(cache, key, async () => {
			throw new Error("offline");
		}),
		/offline/,
	);
	assert.deepEqual(cache.getQueryData(key), [deleting]);
	assert.equal(cache.getQueryState(key)?.status, "error");
	assert.equal(libraryRefetchInterval(cache.getQueryData(key)), 2_000);
	await fetchBackgroundQuery(cache, key, async () => [] as ApiLibrary[]);
	assert.equal(cache.getQueryState(key)?.status, "success");
	assert.equal(libraryRefetchInterval(cache.getQueryData(key)), false);
});

test("library background polls join the authoritative refresh rather than cancelling it", async (t) => {
	const cache = client();
	t.after(() => cache.clear());
	const key = queryKeys.libraries(scope);
	cache.setQueryData(key, [deleting]);
	const started = deferred<void>();
	const result = deferred<ApiLibrary[]>();
	let signal: AbortSignal | undefined;
	const fresh = fetchFreshQuery(cache, key, ({ signal: current }) => {
		signal = current;
		started.resolve();
		return result.promise;
	});
	await started.promise;
	let pollCalled = false;
	const poll = fetchBackgroundQuery(cache, key, async () => {
		pollCalled = true;
		return [deleting];
	});
	result.resolve([]);
	assert.deepEqual(await fresh, []);
	assert.deepEqual(await poll, []);
	assert.equal(pollCalled, false);
	assert.equal(signal?.aborted, false);
});

test("switching the workspace observer cancels its old fetch and ignores the late deleting response", async (t) => {
	const cache = client();
	t.after(() => cache.clear());
	const oldKey = queryKeys.libraries(scope);
	const newKey = queryKeys.libraries({ ...scope, workspaceId: "workspace-b" });
	cache.setQueryData(oldKey, [deleting]);
	const late = deferred<ApiLibrary[]>();
	const oldStarted = deferred<void>();
	let oldSignal: AbortSignal | undefined;
	const observer = new QueryObserver(cache, {
		queryKey: oldKey,
		queryFn: ({ signal }) => {
			oldSignal = signal;
			oldStarted.resolve();
			return late.promise;
		},
		refetchInterval: (query) => libraryRefetchInterval(query.state.data),
	});
	const unsubscribe = observer.subscribe(() => {});
	t.after(unsubscribe);
	await oldStarted.promise;
	observer.setOptions({
		queryKey: newKey,
		queryFn: async () => [library],
		refetchInterval: (query) => libraryRefetchInterval(query.state.data),
	});
	await cache.fetchQuery({ queryKey: newKey });
	assert.equal(oldSignal?.aborted, true);
	late.resolve([{ ...deleting, name: "late old workspace" }]);
	await Promise.resolve();
	assert.deepEqual(observer.getCurrentResult().data, [library]);
	assert.deepEqual(cache.getQueryData(oldKey), [deleting]);
	assert.deepEqual(cache.getQueryData(newKey), [library]);
	assert.equal(libraryRefetchInterval(observer.getCurrentResult().data), false);
	assert.equal(
		cache.getQueryCache().find({ queryKey: oldKey })?.getObserversCount(),
		0,
	);
});
