import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import {
	buildDetailActions,
	type DocActionContext,
	resolveDocActions,
} from "../../src/components/app/library-doc-actions";
import type { ApiDocument, ApiDocumentsPage } from "../../src/lib/api";
import { fetchDocumentsPage, fetchThreadsPage } from "../../src/lib/api";
import {
	documentPageQueryOptions,
	documentQueryOptions,
	documentRefetchInterval,
	hasFinishedDocumentDeletion,
	seedAcceptedDocumentDeletion,
} from "../../src/lib/document-query-state";
import { interfaceText } from "../../src/lib/i18n/locale";
import { queryKeys } from "../../src/lib/query-keys";
import { fetchFreshQuery } from "../../src/lib/query-refresh";

const scope = { organizationId: "org", workspaceId: "workspace" };
const document: ApiDocument = {
	id: "document-a",
	library_id: "library-a",
	name: "Example",
	filename: "example.md",
	content_type: "text/markdown",
	status: "ready",
	has_file: true,
	chunk_count: 3,
	job_id: "old-ingest",
	job_status: "completed",
	job_progress: 100,
	created_at: "2026-11-13T00:00:00Z",
	updated_at: "2026-11-13T00:00:00Z",
};
const deleting = {
	...document,
	status: "deleting",
	job_id: "delete-job",
	job_status: "queued",
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function createClient() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity } },
	});
}

test("only identified active deleting jobs request polling", () => {
	for (const job_status of ["queued", "running", "retry", "cancelling"]) {
		assert.equal(documentRefetchInterval([{ ...deleting, job_status }]), 2_000);
		assert.equal(documentRefetchInterval([{ ...document, job_status }]), false);
		assert.equal(
			documentRefetchInterval([{ ...deleting, job_status, job_id: null }]),
			false,
		);
	}
	for (const job_status of [
		"completed",
		"failed",
		"dead",
		"cancelled",
		"unknown",
		null,
	]) {
		assert.equal(documentRefetchInterval([{ ...deleting, job_status }]), false);
	}
	assert.equal(documentRefetchInterval(undefined), false);
	assert.equal(documentRefetchInterval([]), false);
});

test("terminal transitions include removal and failed cleanup, not unrelated or repeated snapshots", () => {
	assert.equal(hasFinishedDocumentDeletion([deleting], []), true);
	for (const job_status of ["completed", "failed", "dead", "cancelled"]) {
		const terminal = { ...deleting, job_status };
		assert.equal(hasFinishedDocumentDeletion([deleting], [terminal]), true);
		assert.equal(hasFinishedDocumentDeletion([terminal], [terminal]), false);
		assert.equal(
			hasFinishedDocumentDeletion(
				[deleting],
				[{ ...terminal, job_id: "another-job" }],
			),
			false,
		);
	}
	assert.equal(
		hasFinishedDocumentDeletion(
			[deleting],
			[{ ...deleting, job_status: "running" }],
		),
		false,
	);
	assert.equal(hasFinishedDocumentDeletion([document], []), false);
	assert.equal(hasFinishedDocumentDeletion(undefined, []), false);
});

test("library acceptance recovers stale ready or missing jobs after read errors without polling terminal jobs", () => {
	const options = { libraryDeleting: true };
	assert.equal(documentRefetchInterval([document], options), 2_000);
	assert.equal(documentRefetchInterval(undefined, options), 2_000);
	assert.equal(
		documentRefetchInterval([document], { ...options, errorCount: 1 }),
		2_000,
	);
	assert.equal(
		documentRefetchInterval([document], { ...options, errorCount: 2 }),
		4_000,
	);
	assert.equal(
		documentRefetchInterval([document], { ...options, errorCount: 100 }),
		30_000,
	);
	for (const job_status of ["failed", "cancelled", "dead", "completed"]) {
		assert.equal(
			documentRefetchInterval([{ ...deleting, job_status }], options),
			false,
		);
	}
	assert.equal(documentRefetchInterval([deleting], options), 2_000);
	assert.equal(
		documentRefetchInterval([{ ...deleting, job_status: "failed" }], {
			...options,
			deleteJobsActive: true,
		}),
		2_000,
		"server-observed external retry must refresh an old failed snapshot",
	);
	assert.equal(documentRefetchInterval([], options), false);
	assert.equal(
		documentRefetchInterval([document], {
			libraryDeleting: false,
			errorCount: 2,
		}),
		false,
	);
});

test("accepted delete cancels an old fetch, retains the row and cannot affect another library or workspace", async (t) => {
	const client = createClient();
	t.after(() => client.clear());
	const key = queryKeys.documents(scope, document.library_id);
	const otherKey = queryKeys.documents(scope, "library-b");
	const otherScopeKey = queryKeys.documents(
		{ ...scope, workspaceId: "other" },
		document.library_id,
	);
	client.setQueryData(key, [document]);
	client.setQueryData(otherKey, [document]);
	client.setQueryData(otherScopeKey, [document]);
	const oldResponse = deferred<ApiDocument[]>();
	let oldSignal: AbortSignal | undefined;
	const old = client.fetchQuery({
		queryKey: key,
		queryFn: ({ signal }) => {
			oldSignal = signal;
			return oldResponse.promise;
		},
	});
	await seedAcceptedDocumentDeletion(client, scope, document, {
		id: "accepted-job",
		status: "queued",
	});
	assert.equal(oldSignal?.aborted, true);
	oldResponse.resolve([document]);
	await old;
	const rows = client.getQueryData<ApiDocument[]>(key);
	assert.ok(rows);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].job_id, "accepted-job");
	assert.equal(rows[0].status, "deleting");
	assert.equal(rows[0].job_status, "queued");
	assert.equal(rows[0].job_progress, null);
	assert.equal(documentRefetchInterval(rows), 2_000);
	assert.deepEqual(client.getQueryData(otherKey), [document]);
	assert.deepEqual(client.getQueryData(otherScopeKey), [document]);
});

test("acceptance does not recreate a row already removed by an authoritative read", async (t) => {
	const client = createClient();
	t.after(() => client.clear());
	const key = queryKeys.documents(scope, document.library_id);
	client.setQueryData(key, []);
	await seedAcceptedDocumentDeletion(client, scope, document, {
		id: "accepted-job",
		status: "queued",
	});
	assert.deepEqual(client.getQueryData(key), []);
});

for (const terminal of [
	"removed",
	"failed",
	"dead",
	"cancelled",
	"completed",
]) {
	test(`document ${terminal} refreshes scoped counts once and stops deletion polling`, async (t) => {
		const client = createClient();
		t.after(() => client.clear());
		const options = documentQueryOptions(client, scope, document.library_id);
		client.setQueryData(options.queryKey, [deleting]);
		const librariesKey = queryKeys.libraries(scope);
		const otherLibrariesKey = queryKeys.libraries({
			...scope,
			workspaceId: "other",
		});
		client.setQueryData(otherLibrariesKey, ["untouched"]);
		const countsUpdated = deferred<void>();
		const unsubscribe = client.getQueryCache().subscribe((event) => {
			if (
				event.type === "updated" &&
				event.action.type === "success" &&
				event.query.queryHash === JSON.stringify(librariesKey)
			)
				countsUpdated.resolve();
		});
		t.after(unsubscribe);
		let countReads = 0;
		const rows =
			terminal === "removed"
				? []
				: [{ ...deleting, job_status: terminal, error: "cleanup failed" }];
		t.mock.method(globalThis, "fetch", async (url: string) => {
			if (url === "/api/libraries") {
				countReads += 1;
				return Response.json([{ id: document.library_id, doc_count: 0 }]);
			}
			assert.equal(url, `/api/libraries/${document.library_id}/documents`);
			return Response.json(rows);
		});
		assert.deepEqual(
			await fetchFreshQuery(client, options.queryKey, options.queryFn),
			rows,
		);
		await countsUpdated.promise;
		assert.equal(
			documentRefetchInterval(client.getQueryData(options.queryKey)),
			false,
		);
		await fetchFreshQuery(client, options.queryKey, options.queryFn);
		assert.equal(countReads, 1);
		assert.deepEqual(client.getQueryData(otherLibrariesKey), ["untouched"]);
	});
}

test("failed post-acceptance reads retain the accepted job and polling; retry seeds the new job", async (t) => {
	const client = createClient();
	t.after(() => client.clear());
	const options = documentQueryOptions(client, scope, document.library_id);
	client.setQueryData(options.queryKey, [
		{
			...deleting,
			has_file: false,
			job_status: "failed",
			error: "cleanup failed",
		},
	]);
	await seedAcceptedDocumentDeletion(client, scope, document, {
		id: "retry-job",
		status: "queued",
	});
	t.mock.method(
		globalThis,
		"fetch",
		async () => new Response(null, { status: 503 }),
	);
	await assert.rejects(
		fetchFreshQuery(client, options.queryKey, options.queryFn),
		/documents 503/,
	);
	const rows = client.getQueryData<ApiDocument[]>(options.queryKey);
	assert.ok(rows);
	assert.equal(rows[0].job_id, "retry-job");
	assert.equal(rows[0].error, null);
	assert.equal(rows[0].has_file, false);
	assert.equal(documentRefetchInterval(rows), 2_000);
});

test("terminal count refresh cancels an older count snapshot without losing document removal", async (t) => {
	const client = createClient();
	t.after(() => client.clear());
	const options = documentQueryOptions(client, scope, document.library_id);
	const librariesKey = queryKeys.libraries(scope);
	client.setQueryData(options.queryKey, [deleting]);
	client.setQueryData(librariesKey, [
		{ id: document.library_id, doc_count: 1 },
	]);
	const oldResponse = deferred<Response>();
	const freshCounts = deferred<void>();
	let oldSignal: AbortSignal | undefined;
	let countReads = 0;
	t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => {
		if (url !== "/api/libraries") return Promise.resolve(Response.json([]));
		countReads += 1;
		if (countReads === 1) {
			oldSignal = init.signal as AbortSignal;
			return oldResponse.promise;
		}
		return Promise.resolve(
			Response.json([{ id: document.library_id, doc_count: 0 }]),
		);
	});
	const unsubscribe = client.getQueryCache().subscribe((event) => {
		if (
			event.type === "updated" &&
			event.action.type === "success" &&
			event.query.queryHash === JSON.stringify(librariesKey)
		)
			freshCounts.resolve();
	});
	t.after(unsubscribe);
	const old = client.fetchQuery({
		queryKey: librariesKey,
		queryFn: async ({ signal }) =>
			(await fetch("/api/libraries", { signal })).json(),
	});
	await fetchFreshQuery(client, options.queryKey, options.queryFn);
	await freshCounts.promise;
	assert.equal(oldSignal?.aborted, true);
	oldResponse.resolve(
		Response.json([{ id: document.library_id, doc_count: 1 }]),
	);
	await old;
	assert.deepEqual(client.getQueryData(options.queryKey), []);
	assert.deepEqual(client.getQueryData(librariesKey), [
		{ id: document.library_id, doc_count: 0 },
	]);
});

test("a failed terminal count refresh is isolated from successful document removal", async (t) => {
	const client = createClient();
	t.after(() => client.clear());
	const options = documentQueryOptions(client, scope, document.library_id);
	const librariesKey = queryKeys.libraries(scope);
	client.setQueryData(options.queryKey, [deleting]);
	const countFailed = deferred<void>();
	const unsubscribe = client.getQueryCache().subscribe((event) => {
		if (
			event.type === "updated" &&
			event.action.type === "error" &&
			event.query.queryHash === JSON.stringify(librariesKey)
		)
			countFailed.resolve();
	});
	t.after(unsubscribe);
	t.mock.method(globalThis, "fetch", async (url: string) =>
		url === "/api/libraries"
			? new Response(null, { status: 503 })
			: Response.json([]),
	);
	assert.deepEqual(
		await fetchFreshQuery(client, options.queryKey, options.queryFn),
		[],
	);
	await countFailed.promise;
	assert.equal(client.getQueryState(options.queryKey)?.status, "success");
	assert.equal(client.getQueryState(librariesKey)?.status, "error");
	assert.equal(
		documentRefetchInterval(client.getQueryData(options.queryKey)),
		false,
	);
});

test("switching a document observer aborts its old read and a captured refresh stays in its original library", async (t) => {
	const client = createClient();
	t.after(() => client.clear());
	const original = documentQueryOptions(client, scope, document.library_id);
	const other = documentQueryOptions(client, scope, "library-b");
	const oldResponse = deferred<Response>();
	let oldSignal: AbortSignal | undefined;
	let first = true;
	const otherDocument = {
		...document,
		id: "document-b",
		library_id: "library-b",
	};
	t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => {
		if (url.includes("library-b"))
			return Promise.resolve(Response.json([otherDocument]));
		if (first) {
			first = false;
			oldSignal = init.signal as AbortSignal;
			return oldResponse.promise;
		}
		return Promise.resolve(Response.json([deleting]));
	});
	const observer = new QueryObserver(client, original);
	const unsubscribe = observer.subscribe(() => {});
	t.after(unsubscribe);
	observer.setOptions(other);
	assert.equal(oldSignal?.aborted, true);
	await client.fetchQuery(other);
	await fetchFreshQuery(client, original.queryKey, original.queryFn);
	oldResponse.resolve(Response.json([document]));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(client.getQueryData(original.queryKey), [deleting]);
	assert.deepEqual(observer.getCurrentResult().data, [otherDocument]);
});

test("an aborted document read cannot trigger terminal count refresh even if its transport resolves late", async (t) => {
	const client = createClient();
	t.after(() => client.clear());
	const options = documentQueryOptions(client, scope, document.library_id);
	client.setQueryData(options.queryKey, [deleting]);
	const late = deferred<Response>();
	let countReads = 0;
	t.mock.method(globalThis, "fetch", (url: string) => {
		if (url === "/api/libraries") countReads += 1;
		return late.promise;
	});
	const controller = new AbortController();
	const pending = options.queryFn({ signal: controller.signal });
	controller.abort();
	late.resolve(Response.json([]));
	await assert.rejects(pending, { name: "AbortError" });
	assert.equal(countReads, 0);
	assert.deepEqual(client.getQueryData(options.queryKey), [deleting]);
});

test("delete actions prevent duplicate commands and permit manager retry without a source file", () => {
	const caps = {
		canManageLibraries: true,
		canWriteLibraries: true,
		canManageMembers: false,
	};
	const noop = () => {};
	const context: DocActionContext = {
		busy: false,
		processing: false,
		onView: noop,
		onAcl: noop,
		onReplace: noop,
		onReindex: noop,
		onCancelJob: noop,
		onRetryJob: noop,
		onDownload: noop,
		onDelete: noop,
	};
	for (const job_status of [
		"queued",
		"running",
		"retry",
		"cancelling",
		"failed",
		"dead",
		"cancelled",
	]) {
		const row = { ...deleting, job_status, has_file: false };
		const actions = resolveDocActions(caps, row);
		for (const id of ["delete", "replace", "reindex"]) {
			assert.equal(
				actions.find((action) => action.id === id)?.disabled?.(row, context),
				true,
			);
		}
		assert.equal(
			actions.some((action) => action.id === "cancel"),
			false,
		);
		const retryable = ["failed", "dead", "cancelled"].includes(job_status);
		const retry = actions.find((action) => action.id === "retry");
		assert.equal(Boolean(retry), retryable);
		if (retry) {
			assert.equal(retry.disabled?.(row, context), false);
			assert.equal(retry.disabled?.(row, { ...context, busy: true }), true);
		}
		assert.equal(
			resolveDocActions({ ...caps, canManageLibraries: false }, row).some(
				(action) => action.id === "retry",
			),
			false,
		);
		assert.equal(
			buildDetailActions(caps, row, context, interfaceText("en"))
				.find((action) => action.id === "delete")
				?.disabled?.(row, false),
			true,
		);
	}
	const ingestRetry = { ...document, job_status: "failed", has_file: false };
	assert.equal(
		resolveDocActions(caps, ingestRetry)
			.find((action) => action.id === "retry")
			?.disabled?.(ingestRetry, context),
		true,
	);
});

test("paginated document queries support deletion seeding, polling, count refresh, and legacy array fallback", async (t) => {
	const client = createClient();
	t.after(() => client.clear());
	const options = documentPageQueryOptions(client, scope, document.library_id, {
		query: "example",
		task: "all",
		page: 1,
		pageSize: 50,
	});
	const initialPage: ApiDocumentsPage = {
		items: [deleting],
		total: 120,
		filtered_total: 1,
		limit: 50,
		offset: 0,
		has_more: false,
		summary: { total: 120, completed: 118, processing: 1, failed: 1 },
	};
	client.setQueryData(options.queryKey, initialPage);

	const otherPageOptions = documentPageQueryOptions(
		client,
		scope,
		"library-b",
		{
			query: "",
			task: "all",
			page: 1,
			pageSize: 50,
		},
	);
	client.setQueryData(otherPageOptions.queryKey, {
		...initialPage,
		items: [{ ...document, library_id: "library-b" }],
	});

	await seedAcceptedDocumentDeletion(client, scope, document, {
		id: "accepted-paged-delete",
		status: "queued",
	});
	const seeded = client.getQueryData<ApiDocumentsPage>(options.queryKey);
	assert.equal(seeded?.items[0]?.job_id, "accepted-paged-delete");
	assert.equal(seeded?.items[0]?.status, "deleting");
	assert.equal(documentRefetchInterval(seeded?.items), 2_000);
	assert.equal(
		client.getQueryData<ApiDocumentsPage>(otherPageOptions.queryKey)?.items[0]
			?.status,
		"ready",
	);

	// Legacy plain-array server/mock responses degrade cleanly into ApiDocumentsPage.
	t.mock.method(globalThis, "fetch", async (url: string) => {
		if (url.startsWith("/api/libraries/")) {
			assert.match(url, /paginated=1/);
			assert.match(url, /include_report=0/);
			return Response.json([
				document,
				{
					...document,
					id: "document-failed",
					name: "Broken policy",
					filename: "broken.pdf",
					job_status: "failed",
				},
			]);
		}
		return Response.json([
			{
				id: "t1",
				session_id: "s1",
				library_id: "lib-a",
				title: "Budget summary",
				status: "active",
				turn_count: 2,
				created_at: "2026-01-02T00:00:00Z",
				updated_at: "2026-01-02T00:00:00Z",
			},
			{
				id: "t2",
				session_id: "s2",
				library_id: "lib-b",
				title: "Leave rules",
				status: "active",
				turn_count: 1,
				created_at: "2026-01-01T00:00:00Z",
				updated_at: "2026-01-01T00:00:00Z",
			},
		]);
	});
	const docPage = await fetchDocumentsPage(document.library_id, {
		query: "broken",
		task: "failed",
		limit: 10,
		offset: 0,
	});
	assert.equal(docPage.total, 2);
	assert.equal(docPage.filtered_total, 1);
	assert.equal(docPage.summary.failed, 1);
	assert.equal(docPage.summary.completed, 1);
	assert.deepEqual(
		docPage.items.map((item) => item.id),
		["document-failed"],
	);

	const threadPage = await fetchThreadsPage({
		limit: 40,
		query: "leave",
		libraryId: "lib-b",
	});
	assert.equal(threadPage.has_more, false);
	assert.deepEqual(
		threadPage.items.map((item) => item.id),
		["t2"],
	);
});
