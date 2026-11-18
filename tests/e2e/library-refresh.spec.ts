import {
	type Cookie,
	expect,
	type Locator,
	type Page,
	test,
} from "@playwright/test";
import type {
	ApiDocument,
	ApiJob,
	ApiLibrary,
	ApiUploadResponse,
} from "../../src/lib/api";
import { chooseSelect } from "./select-helpers";

let cookies: Cookie[] = [];
let workspaceId = "";
let workspaceName = "";
test.beforeAll(async ({ browser }) => {
	const email = process.env.UNORAG_E2E_ADMIN_EMAIL;
	const password = process.env.UNORAG_E2E_ADMIN_PASSWORD;
	if (!email || !password)
		throw new Error("E2E administrator credentials required");
	const context = await browser.newContext({
		baseURL: process.env.UNORAG_E2E_BASE_URL,
	});
	try {
		const auth = await context.request.post("/api/auth/session", {
			data: { email, password },
		});
		expect(auth.ok()).toBe(true);
		const identity = await auth.json();
		workspaceId = identity.workspaceId;
		workspaceName = identity.workspaceName;
		cookies = await context.cookies();
	} finally {
		await context.close();
	}
});
test.beforeEach(async ({ context }) => {
	await context.addCookies(cookies);
});

function deletionFixture() {
	const stamp = "2026-11-18T00:00:00Z";
	const library: ApiLibrary = {
		id: "deletion-library",
		name: "Deletion fixture",
		status: "ready",
		doc_count: 1,
		ready_count: 1,
		delete_jobs_active: false,
		created_at: stamp,
		updated_at: stamp,
	};
	const document: ApiDocument = {
		id: "deletion-document",
		library_id: library.id,
		name: "Deletion document",
		filename: "deletion.md",
		content_type: "text/markdown",
		status: "ready",
		has_file: true,
		chunk_count: 3,
		job_id: "old-ingest",
		job_status: "completed",
		created_at: stamp,
		updated_at: stamp,
	};
	return { library, document };
}

function responseGate() {
	let release = () => {};
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { pending, release };
}

async function confirmDocumentDeletion(page: Page) {
	await page.getByRole("button", { name: "操作", exact: true }).click();
	await page.getByRole("menuitem", { name: "删除", exact: true }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "确认删除", exact: true })
		.click();
}

async function confirmLibraryDeletion(page: Page) {
	await page.getByRole("button", { name: "知识库设置", exact: true }).click();
	await page.getByRole("menuitem", { name: "删除知识库", exact: true }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "确认删除", exact: true })
		.click();
}

async function expectDeletingLibrary(
	page: Page,
	mobile: boolean,
	name: string,
) {
	if (mobile) {
		await expect(
			page.getByRole("combobox", { name: "当前知识库", exact: true }),
		).toHaveValue(`${name} · 删除中`);
	} else {
		const item = page
			.getByRole("complementary", { name: "知识库导航" })
			.getByRole("button", { name: new RegExp(name) });
		await expect(item).toContainText("删除中");
		await expect(item).not.toContainText("可检索");
	}
}

test("whole library deletion cancels old reads, retains deleting through read failure, then removes without reload", async ({
	page,
	isMobile,
}) => {
	const { library, document } = deletionFixture();
	let accepted = false;
	let removed = false;
	let failing = false;
	let reads = 0;
	let deleteRequests = 0;
	let holdOld = false;
	let oldHeld = false;
	let oldAborted = false;
	let freshHeld = false;
	const old = responseGate();
	const fresh = responseGate();
	page.on("requestfailed", (request) => {
		if (new URL(request.url()).pathname === "/api/libraries") oldAborted = true;
	});
	await page.route("**/api/libraries", async (route) => {
		reads += 1;
		if (holdOld && !accepted && !oldHeld) {
			oldHeld = true;
			await old.pending;
			await route.fulfill({ json: [library] }).catch(() => {});
			return;
		}
		if (accepted && !freshHeld) {
			freshHeld = true;
			await fresh.pending;
		}
		await route.fulfill(
			failing
				? { status: 503, json: { detail: "fixture library poll unavailable" } }
				: {
						json: removed
							? []
							: [
									{
										...library,
										status: accepted ? "deleting" : "ready",
										delete_jobs_active: accepted,
									},
								],
					},
		);
	});
	// Keep the document read unchanged: only library polling can discover its completed removal.
	await page.route(`**/api/libraries/${library.id}/documents`, (route) =>
		route.fulfill({ json: [document] }),
	);
	await page.route(`**/api/libraries/${library.id}`, (route) => {
		expect(route.request().method()).toBe("DELETE");
		deleteRequests += 1;
		accepted = true;
		return route.fulfill({
			status: 202,
			json: {
				ok: true,
				library_id: library.id,
				accepted: true,
				status: "deleting",
				deleted_documents: 1,
				delete_jobs_queued: 1,
				cleanup_queued: true,
			},
		});
	});
	try {
		await page.goto("/app/libraries");
		await expect(
			page.getByRole("button", { name: document.name, exact: true }),
		).toBeVisible();
		await page.clock.install();
		holdOld = true;
		await page.getByRole("button", { name: "刷新文档", exact: true }).click();
		await expect.poll(() => oldHeld).toBe(true);
		await confirmLibraryDeletion(page);
		await expect.poll(() => freshHeld).toBe(true);
		await expect.poll(() => oldAborted).toBe(true);
		await expectDeletingLibrary(page, isMobile, library.name);
		old.release();
		const inFlightReads = reads;
		await page.clock.fastForward(6_100);
		expect(reads).toBe(inFlightReads);
		failing = true;
		fresh.release();
		await page.clock.runFor(1_100);
		await expect(
			page.getByRole("alert").filter({ hasText: "libraries 503" }),
		).toBeVisible();
		await expectDeletingLibrary(page, isMobile, library.name);
		await expect(page.getByText("还没有知识库", { exact: true })).toHaveCount(
			0,
		);
		await expect(
			page.getByRole("button", { name: "上传文档", exact: true }),
		).toBeDisabled();
		await page.getByRole("button", { name: "知识库设置", exact: true }).click();
		await expect(
			page.getByRole("menuitem", { name: "编辑设置", exact: true }),
		).toBeDisabled();
		await expect(
			page.getByRole("menuitem", { name: "删除知识库", exact: true }),
		).toBeDisabled();
		await page.keyboard.press("Escape");
		failing = false;
		removed = true;
		await page.clock.fastForward(2_100);
		await expect(
			page.getByRole("button", { name: document.name, exact: true }),
		).toHaveCount(0);
		await expect(
			page.getByText("还没有知识库", { exact: true }).last(),
		).toBeVisible();
		await expect(
			page.getByRole("alert").filter({ hasText: "libraries 503" }),
		).toHaveCount(0);
		const terminalReads = reads;
		await page.clock.fastForward(6_100);
		await page.clock.runFor(100);
		expect(reads).toBe(terminalReads);
		expect(deleteRequests).toBe(1);
	} finally {
		old.release();
		fresh.release();
	}
});

test("whole library deletion recovers a failed job read, backs off terminal jobs and resumes on retry", async ({
	page,
	isMobile,
}) => {
	const { library, document } = deletionFixture();
	let accepted = false;
	let retried = false;
	let removed = false;
	let deletes = 0;
	let failDocumentRead = true;
	let libraryReads = 0;
	let documentReads = 0;
	await page.route("**/api/libraries", (route) => {
		libraryReads += 1;
		return route.fulfill({
			json: removed
				? []
				: [
						{
							...library,
							status: accepted ? "deleting" : "ready",
							delete_jobs_active: retried,
						},
					],
		});
	});
	await page.route(`**/api/libraries/${library.id}/documents`, (route) => {
		documentReads += 1;
		if (accepted && failDocumentRead)
			return route.fulfill({
				status: 503,
				json: { detail: "fixture read unavailable" },
			});
		return route.fulfill({
			json: [
				accepted
					? {
							...document,
							status: "deleting",
							job_id: retried ? "retried-delete" : "failed-delete",
							job_status: retried ? "queued" : "failed",
							has_file: false,
							error: retried ? null : "fixture cleanup failed",
						}
					: document,
			],
		});
	});
	await page.route(`**/api/libraries/${library.id}`, (route) => {
		deletes += 1;
		accepted = true;
		return route.fulfill({
			status: 202,
			json: {
				ok: true,
				library_id: library.id,
				accepted: true,
				status: "deleting",
				deleted_documents: 1,
				delete_jobs_queued: 1,
			},
		});
	});
	await page.route("**/api/jobs/failed-delete/retry", (route) => {
		expect(route.request().method()).toBe("POST");
		retried = true;
		return route.fulfill({
			status: 202,
			json: {
				id: "retried-delete",
				type: "document.delete",
				status: "queued",
				stage: "cleanup",
				document_id: document.id,
				library_id: library.id,
			},
		});
	});
	await page.goto("/app/libraries");
	const row = page.getByRole("row").filter({ hasText: document.name });
	await expect(row).toBeVisible();
	await page.clock.install();
	await confirmLibraryDeletion(page);
	await expectDeletingLibrary(page, isMobile, library.name);
	await page.clock.runFor(1_100);
	await expect(
		page.getByRole("alert").filter({ hasText: "documents 503" }),
	).toBeVisible();
	await expect(row).toBeVisible();
	failDocumentRead = false;
	await page.clock.fastForward(2_100);
	await expect(row.getByText("处理失败", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("alert").filter({ hasText: "documents 503" }),
	).toHaveCount(0);
	const failedLibraryReads = libraryReads;
	const failedDocumentReads = documentReads;
	await page.clock.fastForward(6_100);
	await page.clock.runFor(100);
	expect(libraryReads).toBe(failedLibraryReads);
	expect(documentReads).toBe(failedDocumentReads);
	await row.getByRole("button", { name: "操作", exact: true }).click();
	await expect(
		page.getByRole("menuitem", { name: "删除", exact: true }),
	).toBeDisabled();
	await page.getByRole("menuitem", { name: "重试任务", exact: true }).click();
	await expect(row.getByText("排队中", { exact: true })).toBeVisible();
	expect(retried).toBe(true);
	removed = true;
	await page.clock.fastForward(2_100);
	await expect(row).toHaveCount(0);
	await expect(
		page.getByText("还没有知识库", { exact: true }).last(),
	).toBeVisible();
	expect(deletes).toBe(1);
});

test("external library delete retry replaces a cached failed job with the new job identity", async ({
	page,
}) => {
	const { library, document } = deletionFixture();
	let externalRetry = false;
	let activeReads = 0;
	let documentReads = 0;
	const jobReads: string[] = [];
	await page.route("**/api/libraries", (route) => {
		if (externalRetry) activeReads += 1;
		return route.fulfill({
			json: [
				{ ...library, status: "deleting", delete_jobs_active: externalRetry },
			],
		});
	});
	await page.route(`**/api/libraries/${library.id}/documents`, (route) => {
		documentReads += 1;
		return route.fulfill({
			json: [
				{
					...document,
					status: "deleting",
					job_id: externalRetry ? "external-new-delete" : "old-failed-delete",
					job_status: externalRetry ? "queued" : "failed",
					has_file: false,
					error: externalRetry ? null : "fixture cleanup failed",
				},
			],
		});
	});
	await page.route("**/api/jobs/*", (route) => {
		const id = new URL(route.request().url()).pathname.split("/").at(-1) ?? "";
		jobReads.push(id);
		return route.fulfill({
			json: {
				id,
				type: "document.delete",
				status: "queued",
				stage: "cleanup",
				progress: 0,
				attempt: 0,
				max_attempts: 3,
				document_id: document.id,
				document_version_id: "fixture-version",
				generation_id: "fixture-generation",
				library_id: library.id,
				created_at: document.created_at,
				updated_at: document.updated_at,
			} satisfies ApiJob,
		});
	});
	// Version/content reads remain closed during deletion; only task metadata is readable.
	await page.route(
		`**/api/libraries/${library.id}/documents/${document.id}/versions`,
		(route) =>
			route.fulfill({ status: 404, json: { detail: "library not found" } }),
	);
	await page.clock.install();
	await page.goto("/app/libraries");
	const row = page.getByRole("row").filter({ hasText: document.name });
	await expect(row.getByText("处理失败", { exact: true })).toBeVisible();
	const failedReads = documentReads;
	await page.clock.fastForward(6_100);
	await page.clock.runFor(100);
	expect(documentReads).toBe(failedReads);
	// No local retry, refresh, or reload: a different administrator changes server state.
	externalRetry = true;
	await page.clock.fastForward(30_100);
	await expect.poll(() => activeReads).toBeGreaterThan(0);
	await page.clock.fastForward(2_100);
	await expect(row.getByText("排队中", { exact: true })).toBeVisible();
	await row.getByRole("button", { name: "操作", exact: true }).click();
	await expect(
		page.getByRole("menuitem", { name: "重试任务", exact: true }),
	).toHaveCount(0);
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: document.name, exact: true }).click();
	await expect(
		page.getByText("external-new-delete", { exact: true }),
	).toBeVisible();
	expect(jobReads.length).toBeGreaterThan(0);
	expect(jobReads.every((id) => id === "external-new-delete")).toBe(true);
});

test("workspace-switch navigation cancels the old library deletion poll and ignores its late response", async ({
	page,
	isMobile,
}) => {
	// Two full SSR navigations can exceed 30s on the shared development server.
	test.setTimeout(60_000);
	const { library } = deletionFixture();
	const other = {
		...library,
		id: "other-workspace-library",
		name: "Other workspace library",
		status: "ready",
	};
	const otherWorkspaceId = "6d18ff0c-0fb0-4d85-a1ab-3ff99b7e8801";
	let switched = false;
	let oldReads = 0;
	let newReads = 0;
	let holdPoll = false;
	let held = false;
	let aborted = false;
	const late = responseGate();
	await page.route("**/api/workspaces", (route) =>
		route.fulfill({
			json: {
				can_create: false,
				items: [
					{
						id: workspaceId,
						name: workspaceName,
						role: "admin",
						current: !switched,
					},
					{
						id: otherWorkspaceId,
						name: "Other scope fixture",
						role: "admin",
						current: switched,
					},
				],
			},
		}),
	);
	await page.route("**/api/auth/session/workspace", (route) => {
		expect(route.request().postDataJSON()).toEqual({
			workspace_id: otherWorkspaceId,
		});
		switched = true;
		return route.fulfill({ json: { workspaceId: otherWorkspaceId } });
	});
	await page.route("**/api/libraries", async (route) => {
		if (switched) {
			newReads += 1;
			await route.fulfill({ json: [other] });
			return;
		}
		oldReads += 1;
		if (holdPoll) {
			held = true;
			await late.pending;
		}
		await route
			.fulfill({
				json: [{ ...library, status: "deleting", delete_jobs_active: true }],
			})
			.catch(() => {});
	});
	await page.route("**/api/libraries/*/documents", (route) =>
		route.fulfill({ json: [] }),
	);
	page.on("requestfailed", (request) => {
		if (held && new URL(request.url()).pathname === "/api/libraries")
			aborted = true;
	});
	try {
		await page.goto("/app/libraries");
		await expectDeletingLibrary(page, isMobile, library.name);
		await page.clock.install();
		holdPoll = true;
		await page.clock.fastForward(2_100);
		await expect.poll(() => held).toBe(true);
		if (isMobile)
			await page
				.getByRole("button", { name: "切换侧边栏", exact: true })
				.first()
				.click();
		await page
			.getByRole("button", { name: new RegExp(workspaceName) })
			.first()
			.click();
		await page.getByRole("menuitem", { name: /Other scope fixture/ }).click();
		await expect(page).toHaveURL(/\/app\/ask$/);
		await expect.poll(() => newReads).toBeGreaterThan(0);
		await expect.poll(() => aborted).toBe(true);
		late.release();
		await expect(
			page.getByRole("combobox", { name: "知识库", exact: true }),
		).toHaveValue(other.name);
		const oldCount = oldReads;
		const newCount = newReads;
		await page.clock.fastForward(6_100);
		await page.clock.runFor(100);
		expect(oldReads).toBe(oldCount);
		expect(newReads).toBe(newCount);
		await expect(
			page.getByRole("combobox", { name: "知识库", exact: true }),
		).toHaveValue(other.name);
	} finally {
		late.release();
	}
});

for (const outcome of ["completed", "failed"] as const) {
	test(`async document deletion waits for slow ${outcome}, stops polling and supports cleanup retry`, async ({
		page,
		isMobile,
	}) => {
		const { library, document } = deletionFixture();
		let rows = [document];
		let deleteRequests = 0;
		let retryRequests = 0;
		let documentReads = 0;
		let libraryReads = 0;
		let terminal = false;
		let held = false;
		const initialRefresh = responseGate();
		await page.route("**/api/libraries", (route) => {
			libraryReads += 1;
			return route.fulfill({
				json: [
					{
						...library,
						doc_count: terminal ? 0 : 1,
						ready_count: terminal ? 0 : 1,
					},
				],
			});
		});
		await page.route(
			`**/api/libraries/${library.id}/documents`,
			async (route) => {
				documentReads += 1;
				if (deleteRequests && !held) {
					held = true;
					await initialRefresh.pending;
				}
				await route.fulfill({ json: rows });
			},
		);
		await page.route(
			`**/api/libraries/${library.id}/documents/${document.id}`,
			async (route) => {
				expect(route.request().method()).toBe("DELETE");
				deleteRequests += 1;
				rows = [
					{
						...document,
						status: "deleting",
						job_id: "accepted-delete",
						job_status: "running",
						job_stage: "cleanup",
					},
				];
				await route.fulfill({
					status: 202,
					json: {
						ok: true,
						accepted: true,
						status: "deleting",
						job_id: "accepted-delete",
					},
				});
			},
		);
		await page.route("**/api/jobs/accepted-delete/retry", async (route) => {
			expect(route.request().method()).toBe("POST");
			retryRequests += 1;
			rows = [
				{
					...rows[0],
					job_id: "retried-delete",
					job_status: "queued",
					error: null,
				},
			];
			await route.fulfill({
				status: 202,
				json: {
					id: "retried-delete",
					type: "document.delete",
					status: "queued",
					stage: "cleanup",
					progress: 0,
					document_id: document.id,
					library_id: library.id,
				},
			});
		});
		try {
			await page.goto("/app/libraries");
			const row = page.getByRole("row").filter({
				has: page.getByRole("button", { name: document.name, exact: true }),
			});
			await expect(row).toBeVisible();
			await page.clock.install();
			await confirmDocumentDeletion(page);
			await expect(page.getByRole("alertdialog")).toHaveCount(0);
			await expect.poll(() => held).toBe(true);
			// The held GET cannot supply this state: it must use the accepted job ID.
			await expect(row.getByText("排队中", { exact: true })).toBeVisible();
			const readsDuringRefresh = documentReads;
			await page.clock.fastForward(6_100);
			expect(documentReads).toBe(readsDuringRefresh);
			initialRefresh.release();
			await expect(row.getByText("处理中", { exact: true })).toBeVisible();
			await row.getByRole("button", { name: "操作", exact: true }).click();
			await expect(
				page.getByRole("menuitem", { name: "删除", exact: true }),
			).toBeDisabled();
			await expect(
				page.getByRole("menuitem", { name: "取消任务", exact: true }),
			).toHaveCount(0);
			await expect(
				page.getByRole("menuitem", { name: "重试任务", exact: true }),
			).toHaveCount(0);
			await page.keyboard.press("Escape");
			for (const [status, label] of [
				["retry", "等待重试"],
				["cancelling", "取消中"],
				["running", "处理中"],
			]) {
				rows = [{ ...rows[0], job_status: status }];
				const before = documentReads;
				await page.clock.fastForward(2_100);
				await expect.poll(() => documentReads).toBeGreaterThan(before);
				await expect(row.getByText(label, { exact: true })).toBeVisible();
			}
			const countsBeforeTerminal = libraryReads;
			terminal = true;
			rows =
				outcome === "completed"
					? []
					: [
							{
								...rows[0],
								job_status: "failed",
								has_file: false,
								error: "fixture cleanup failed",
							},
						];
			await page.clock.fastForward(2_100);
			if (outcome === "completed") await expect(row).toHaveCount(0);
			else
				await expect(row.getByText("处理失败", { exact: true })).toBeVisible();
			await expect
				.poll(() => libraryReads)
				.toBeGreaterThan(countsBeforeTerminal);
			if (!isMobile) {
				await expect(
					page
						.getByRole("complementary", { name: "知识库导航" })
						.getByRole("button", { name: new RegExp(library.name) }),
				).toContainText("0/0 可检索");
			}
			const terminalReads = documentReads;
			await page.clock.fastForward(10_000);
			await page.clock.runFor(100);
			expect(documentReads).toBe(terminalReads);
			if (outcome === "failed") {
				await row.getByRole("button", { name: "操作", exact: true }).click();
				await expect(
					page.getByRole("menuitem", { name: "删除", exact: true }),
				).toBeDisabled();
				await page
					.getByRole("menuitem", { name: "重试任务", exact: true })
					.click();
				await expect(row.getByText("排队中", { exact: true })).toBeVisible();
				await expect.poll(() => retryRequests).toBe(1);
				rows = [];
				await page.clock.fastForward(2_100);
				await expect(row).toHaveCount(0);
				const completedReads = documentReads;
				await page.clock.fastForward(10_000);
				await page.clock.runFor(100);
				expect(documentReads).toBe(completedReads);
			}
			expect(deleteRequests).toBe(1);
		} finally {
			initialRefresh.release();
		}
	});
}

test("accepted deletion cancels a stale pre-delete list request instead of restoring its completed ingest row", async ({
	page,
}) => {
	const { library, document } = deletionFixture();
	const stale = responseGate();
	let holdOldRead = false;
	let held = false;
	let accepted = false;
	let completed = false;
	let aborted = false;
	const documentPath = `/api/libraries/${library.id}/documents`;
	page.on("requestfailed", (request) => {
		if (new URL(request.url()).pathname === documentPath) aborted = true;
	});
	await page.route("**/api/libraries", (route) =>
		route.fulfill({ json: [library] }),
	);
	await page.route(`**${documentPath}`, async (route) => {
		if (holdOldRead && !accepted && !held) {
			held = true;
			await stale.pending;
			await route.fulfill({ json: [document] }).catch(() => {});
			return;
		}
		await route.fulfill({
			json: completed
				? []
				: accepted
					? [
							{
								...document,
								status: "deleting",
								job_id: "delete-job",
								job_status: "running",
							},
						]
					: [document],
		});
	});
	await page.route(`**${documentPath}/${document.id}`, async (route) => {
		accepted = true;
		await route.fulfill({
			status: 202,
			json: {
				ok: true,
				accepted: true,
				status: "deleting",
				job_id: "delete-job",
			},
		});
	});
	try {
		await page.goto("/app/libraries");
		const row = page.getByRole("row").filter({ hasText: document.name });
		await expect(row).toBeVisible();
		await page.clock.install();
		holdOldRead = true;
		await page.getByRole("button", { name: "刷新文档", exact: true }).click();
		await expect.poll(() => held).toBe(true);
		await confirmDocumentDeletion(page);
		await expect(row.getByText("处理中", { exact: true })).toBeVisible();
		await expect.poll(() => aborted).toBe(true);
		stale.release();
		await page.clock.runFor(100);
		await expect(row.getByText("已完成", { exact: true })).toHaveCount(0);
		completed = true;
		await page.clock.fastForward(2_100);
		await expect(row).toHaveCount(0);
	} finally {
		stale.release();
	}
});

test("delete acceptance after switching libraries refreshes only its original document cache", async ({
	page,
	isMobile,
}) => {
	const { library, document } = deletionFixture();
	const other = { ...library, id: "other-library", name: "Other library" };
	const otherDocument = {
		...document,
		id: "other-document",
		library_id: other.id,
		name: "Other document",
	};
	const acceptance = responseGate();
	let submitted = false;
	let accepted = false;
	let completed = false;
	let originalRefreshes = 0;
	let otherReads = 0;
	await page.route("**/api/libraries", (route) =>
		route.fulfill({ json: [library, other] }),
	);
	await page.route(`**/api/libraries/${library.id}/documents`, (route) => {
		if (accepted) originalRefreshes += 1;
		return route.fulfill({
			json: completed
				? []
				: accepted
					? [
							{
								...document,
								status: "deleting",
								job_id: "delete-job",
								job_status: "running",
							},
						]
					: [document],
		});
	});
	await page.route(`**/api/libraries/${other.id}/documents`, (route) => {
		otherReads += 1;
		return route.fulfill({ json: [otherDocument] });
	});
	await page.route(
		`**/api/libraries/${library.id}/documents/${document.id}`,
		async (route) => {
			submitted = true;
			await acceptance.pending;
			accepted = true;
			await route.fulfill({
				status: 202,
				json: {
					ok: true,
					accepted: true,
					status: "deleting",
					job_id: "delete-job",
				},
			});
		},
	);
	async function selectLibrary(name: string) {
		if (isMobile) {
			const picker = page.getByRole("combobox", {
				name: "当前知识库",
				exact: true,
			});
			await picker.fill(name);
			await page.getByRole("option", { name, exact: true }).click();
		} else {
			await page
				.getByRole("complementary", { name: "知识库导航" })
				.getByRole("button", { name: new RegExp(name) })
				.click();
		}
	}
	try {
		await page.goto("/app/libraries");
		await expect(
			page.getByRole("button", { name: document.name, exact: true }),
		).toBeVisible();
		await page.clock.install();
		await confirmDocumentDeletion(page);
		await expect.poll(() => submitted).toBe(true);
		// Navigation can unmount the pending dialog while the accepted response is delayed.
		await page.getByRole("alertdialog").press("Escape");
		await selectLibrary(other.name);
		await expect(
			page.getByRole("button", { name: otherDocument.name, exact: true }),
		).toBeVisible();
		const readsBeforeAcceptance = otherReads;
		acceptance.release();
		await expect.poll(() => originalRefreshes).toBeGreaterThan(0);
		await expect(
			page.getByRole("button", { name: otherDocument.name, exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: document.name, exact: true }),
		).toHaveCount(0);
		expect(otherReads).toBe(readsBeforeAcceptance);
		await selectLibrary(library.name);
		const row = page.getByRole("row").filter({ hasText: document.name });
		await expect(row.getByText("处理中", { exact: true })).toBeVisible();
		completed = true;
		await page.clock.fastForward(2_100);
		await expect(row).toHaveCount(0);
	} finally {
		acceptance.release();
	}
});

async function expectThemeColors(
	action: Locator,
	background = "--primary",
	foreground = "--primary-foreground",
) {
	await expect(action).toBeVisible();
	await expect
		.poll(() =>
			action.evaluate(
				(element, tokens) => {
					const probe = document.createElement("span");
					probe.style.backgroundColor = `var(${tokens.background})`;
					probe.style.color = `var(${tokens.foreground})`;
					document.body.append(probe);
					const expected = getComputedStyle(probe);
					const actual = getComputedStyle(element);
					const matches =
						actual.backgroundColor === expected.backgroundColor &&
						actual.color === expected.color;
					probe.remove();
					return matches;
				},
				{ background, foreground },
			),
		)
		.toBe(true);
}

test("library loading and read failure never claim zero libraries and retry in place", async ({
	page,
	isMobile,
}) => {
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let failing = true;
	await page.route("**/api/libraries", async (route) => {
		await held;
		await route.fulfill(
			failing
				? { status: 503, json: { detail: "fixture library read unavailable" } }
				: { json: [] },
		);
	});
	try {
		await page.goto("/app/libraries");
		await expect(
			page.getByRole("status").filter({ hasText: "正在加载知识库" }),
		).toBeVisible();
		await expect(page.getByText("还没有知识库", { exact: true })).toHaveCount(
			0,
		);
		if (!isMobile) {
			const sidebar = page.getByRole("complementary", { name: "知识库导航" });
			await expect(sidebar.getByText("知识库与文档数量待确认")).toBeVisible();
			const list = sidebar.getByRole("list");
			await expect(list.getByRole("listitem")).toHaveCount(1);
			await expect(list.getByRole("status")).toBeVisible();
		}
		release();
		await expect(
			page.getByText("知识库列表未能加载，暂无法确认资料数量。", {
				exact: true,
			}),
		).toBeVisible();
		await expect(page.getByText("还没有知识库", { exact: true })).toHaveCount(
			0,
		);
		failing = false;
		await page
			.getByRole("button", { name: "重试加载知识库", exact: true })
			.click();
		await expect(
			page.getByText("还没有知识库", { exact: true }).last(),
		).toBeVisible();
		await expect(
			page.getByRole("alert").filter({ hasText: "知识库加载失败" }),
		).toHaveCount(0);
	} finally {
		release();
	}
});

test("pending and failed document reads never masquerade as an empty knowledge base", async ({
	page,
}) => {
	const stamp = "2026-11-13T00:00:00Z";
	const libraryId = "delayed-library";
	await page.route("**/api/libraries", (route) =>
		route.fulfill({
			json: [
				{
					id: libraryId,
					name: "延迟读取资料",
					status: "ready",
					doc_count: 1,
					ready_count: 1,
					created_at: stamp,
					updated_at: stamp,
				},
			],
		}),
	);
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let failing = true;
	await page.route(`**/api/libraries/${libraryId}/documents`, async (route) => {
		await held;
		await route.fulfill(
			failing
				? { status: 503, json: { detail: "fixture read unavailable" } }
				: {
						json: [
							{
								id: "delayed-doc",
								library_id: libraryId,
								name: "加载恢复后的文档",
								filename: "recovered.md",
								content_type: "text/markdown",
								status: "ready",
								chunk_count: 2,
								job_status: "completed",
								created_at: stamp,
								updated_at: stamp,
							},
						],
					},
		);
	});
	try {
		await page.goto("/app/libraries");
		await expect(
			page.getByRole("status").filter({ hasText: "正在加载文档" }),
		).toBeVisible();
		const stats = page.getByRole("region", { name: "文档与任务统计" });
		await expect(
			stats.getByText("文档", { exact: true }).locator(".."),
		).toHaveText("文档--");
		await expect(page.getByText("尚无文档", { exact: true })).toHaveCount(0);
		release();
		await expect(
			page.getByText("文档列表未能加载，暂无法确认资料数量。", { exact: true }),
		).toBeVisible();
		await expect(
			stats.getByText("文档", { exact: true }).locator(".."),
		).toHaveText("文档--");
		failing = false;
		await page
			.getByRole("button", { name: "重试加载文档", exact: true })
			.click();
		await expect(
			page.getByRole("button", { name: "加载恢复后的文档", exact: true }),
		).toBeVisible();
		await expect(
			stats.getByText("文档", { exact: true }).locator(".."),
		).toHaveText("文档1");
		await expect(
			page.getByRole("alert").filter({ hasText: "文档列表加载失败" }),
		).toHaveCount(0);
	} finally {
		release();
	}
});

test("latest-task filters do not infer completion from document readiness", async ({
	page,
}) => {
	const stamp = "2026-11-13T00:00:00Z";
	const statuses = ["failed", "running", "completed", undefined];
	const names = ["待更新制度", "处理中的手册", "已完成索引", "历史资料"];
	const docs: ApiDocument[] = names.map((name, i) => ({
		id: `task-doc-${i}`,
		library_id: "task-library",
		name,
		filename: `${name}.md`,
		content_type: "text/markdown",
		status: i === 1 ? "processing" : "ready",
		chunk_count: 3,
		job_status: statuses[i],
		job_stage: i === 1 ? "embedding" : "done",
		created_at: stamp,
		updated_at: stamp,
	}));
	await page.route("**/api/libraries", (route) =>
		route.fulfill({
			json: [
				{
					id: "task-library",
					name: "任务筛选资料",
					status: "ready",
					doc_count: 4,
					ready_count: 3,
					created_at: stamp,
					updated_at: stamp,
				},
			],
		}),
	);
	await page.route("**/api/libraries/task-library/documents", (route) =>
		route.fulfill({ json: docs }),
	);
	await page.goto("/app/libraries");
	await expect(
		page.getByRole("button", { name: "历史资料", exact: true }),
	).toBeVisible();
	const stats = page.getByRole("region", {
		name: "文档与任务统计",
		exact: true,
	});
	await expect(
		stats.getByText("任务完成", { exact: true }).locator(".."),
	).toHaveText("任务完成1");
	await expect(page.getByText("任务未记录", { exact: true })).toBeVisible();
	const filter = page.getByRole("combobox", {
		name: "最近处理任务",
		exact: true,
	});
	await chooseSelect(filter, "任务失败");
	await expect(
		page.getByRole("button", { name: "待更新制度", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "已完成索引", exact: true }),
	).toHaveCount(0);
	await expect(page.getByText("处理失败", { exact: true })).toBeVisible();
	await chooseSelect(filter, "任务处理中");
	await expect(
		page.getByRole("button", { name: "处理中的手册", exact: true }),
	).toBeVisible();
	await expect(page.getByText("向量化", { exact: true })).toBeVisible();
	await page
		.getByRole("textbox", { name: "搜索文档", exact: true })
		.fill("不存在");
	await expect(page.getByText("没有匹配的文档", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "清除筛选", exact: true }).click();
	await expect(filter).toHaveText("全部任务");
	await expect(
		page.getByRole("button", { name: "历史资料", exact: true }),
	).toBeVisible();
});

test("library navigation keeps search, selection, collapse and document actions usable", async ({
	page,
	isMobile,
}, testInfo) => {
	const stamp = "2026-01-01T00:00:00.000Z";
	const libraries: ApiLibrary[] = ["产品资料", "团队制度", "运维手册"].map(
		(name, index) => ({
			id: `navigation-${index}`,
			name,
			description: `${name}归档`,
			status: "ready",
			doc_count: 1,
			ready_count: 1,
			requires_reindex: index === 0,
			created_at: stamp,
			updated_at: stamp,
		}),
	);
	await page.route("**/api/libraries", (route) =>
		route.fulfill({ json: libraries }),
	);
	await page.route("**/api/libraries/*/documents", (route) => {
		const libraryId = new URL(route.request().url()).pathname.split("/")[3];
		const document: ApiDocument = {
			id: `doc-${libraryId}`,
			library_id: libraryId,
			name: "项目说明",
			filename: "产品说明.pdf",
			content_type: "application/pdf",
			status: "ready",
			chunk_count: 12,
			size_bytes: 10240,
			has_file: true,
			created_at: stamp,
			updated_at: stamp,
		};
		return route.fulfill({ json: [document] });
	});
	await page.goto("/app/libraries");
	for (const theme of ["Vercel", "Claude", "Violet Bloom"]) {
		for (const mode of ["浅色", "深色"]) {
			await page.getByRole("button", { name: "外观设置", exact: true }).click();
			await page.getByRole("radio", { name: theme, exact: true }).check();
			await page.getByRole("radio", { name: mode, exact: true }).check();
			await page.keyboard.press("Escape");
			await expectThemeColors(
				page.getByRole("button", { name: "新建知识库", exact: true }).first(),
			);
			await expectThemeColors(
				page.getByRole("button", { name: "上传文档", exact: true }),
			);
			await expectThemeColors(
				page.getByText("需要重索引", { exact: true }),
				"--warning",
				"--warning-foreground",
			);
		}
	}
	await expect(page.getByText("自动 分块", { exact: true })).toHaveCSS(
		"font-size",
		"12px",
	);
	await expect(page.getByText("自动 解析", { exact: true })).toHaveCSS(
		"font-size",
		"12px",
	);
	await page
		.getByRole("button", { name: "新建知识库", exact: true })
		.first()
		.click();
	await expectThemeColors(
		page.getByRole("dialog").getByRole("button", { name: "创建", exact: true }),
	);
	await page
		.getByRole("button", { name: "解析策略（质量 / 扫描件）", exact: true })
		.click();
	await page.getByRole("button", { name: "解析质量说明", exact: true }).click();
	await expect(
		page
			.getByRole("dialog")
			.last()
			.getByText(/高质量解析在部署允许/),
	).toHaveCSS("font-size", "14px");
	await page.keyboard.press("Escape");
	await page.getByRole("dialog").getByRole("button", { name: "取消" }).click();
	if (!isMobile) {
		const navigation = page.getByRole("complementary", { name: "知识库导航" });
		await navigation.getByRole("textbox", { name: "搜索知识库" }).fill("制度");
		await expect(
			navigation.getByRole("button", { name: /团队制度/ }),
		).toBeVisible();
		await expect(
			navigation.getByRole("button", { name: /产品资料/ }),
		).toHaveCount(0);
		await navigation.getByRole("button", { name: /团队制度/ }).click();
		await expect(
			navigation.getByRole("button", { name: /团队制度/ }),
		).toHaveAttribute("aria-current", "true");
		await expect(page.getByRole("heading", { level: 3 })).toContainText(
			"团队制度",
		);
		await navigation
			.getByRole("button", { name: "收起知识库导航", exact: true })
			.click();
		await expect(
			page.getByRole("button", { name: "项目说明", exact: true }),
		).toBeVisible();
		await navigation
			.getByRole("button", { name: "展开知识库导航", exact: true })
			.click();
		await expect(
			navigation.getByRole("textbox", { name: "搜索知识库" }),
		).toHaveValue("制度");
		await navigation.getByRole("textbox", { name: "搜索知识库" }).fill("");
	}
	await page.getByRole("button", { name: "操作", exact: true }).click();
	await expect(
		page.getByRole("menuitem", { name: "替换文件", exact: true }),
	).toBeVisible();
	await expect(page.getByRole("menuitem", { name: /重索引/ })).toBeVisible();
	await page.keyboard.press("Escape");
	if (!isMobile) {
		for (const width of [320, 768, 1024, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			await expect(
				page.getByRole("button", { name: "项目说明", exact: true }),
			).toBeVisible();
			await expect(
				page.getByRole("button", { name: "操作", exact: true }),
			).toBeVisible();
			await expect
				.poll(() =>
					page
						.getByRole("button", { name: "操作", exact: true })
						.evaluate((button) => {
							const bounds = button.getBoundingClientRect();
							const container = button
								.closest('[data-slot="table-container"]')
								?.getBoundingClientRect();
							return Boolean(
								container &&
									bounds.width >= 44 &&
									bounds.right <= container.right &&
									bounds.left >= container.left,
							);
						}),
				)
				.toBe(true);
			await expect
				.poll(() =>
					page.evaluate(
						() => document.documentElement.scrollWidth <= innerWidth,
					),
				)
				.toBe(true);
			await page.screenshot({
				path: testInfo.outputPath(`library-${width}.png`),
				animations: "disabled",
			});
		}
	}
	await expect
		.poll(() =>
			page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
		)
		.toBe(true);
	await page.screenshot({
		path: testInfo.outputPath("library-navigation.png"),
		animations: "disabled",
	});
});

test("ingest polling cannot cancel the post-create refresh or lose library selection", async ({
	page,
	isMobile,
}, testInfo) => {
	const stamp = "2026-01-01T00:00:00.000Z";
	const existing: ApiLibrary = {
		id: "polling-existing",
		name: "Indexing fixture",
		status: "indexing",
		doc_count: 1,
		ready_count: 0,
		created_at: stamp,
		updated_at: stamp,
	};
	const created: ApiLibrary = {
		id: "polling-created",
		name: "Created during polling",
		status: "empty",
		doc_count: 0,
		ready_count: 0,
		created_at: stamp,
		updated_at: stamp,
	};
	let didCreate = false;
	let held = false;
	let pollsAfterCreate = 0;
	let release = () => {};
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/libraries", async (route) => {
		if (route.request().method() === "POST") {
			didCreate = true;
			await route.fulfill({ status: 201, json: created });
			return;
		}
		if (didCreate && !held) {
			held = true;
			await pending;
		}
		await route
			.fulfill({ json: didCreate ? [existing, created] : [existing] })
			.catch(() => {});
	});
	await page.route("**/api/libraries/*/documents", async (route) => {
		if (didCreate) pollsAfterCreate += 1;
		const libraryId = new URL(route.request().url()).pathname.split("/")[3];
		const documents: ApiDocument[] =
			libraryId === existing.id
				? [
						{
							id: "polling-document",
							library_id: existing.id,
							name: "Pending fixture",
							filename: "pending.pdf",
							content_type: "application/pdf",
							status: "processing",
							chunk_count: 0,
							created_at: stamp,
							updated_at: stamp,
						},
					]
				: [];
		await route.fulfill({ json: documents });
	});
	try {
		await page.goto("/app/libraries");
		const selected = isMobile
			? page.getByRole("combobox", { name: "当前知识库", exact: true })
			: page.getByRole("heading", { level: 3 });
		if (isMobile) await expect(selected).toHaveValue(new RegExp(existing.name));
		else await expect(selected).toContainText(existing.name);
		await page
			.getByRole("button", { name: "新建知识库", exact: true })
			.first()
			.click();
		await page
			.getByRole("dialog")
			.getByRole("textbox", { name: "名称", exact: true })
			.fill(created.name);
		await page
			.getByRole("dialog")
			.getByRole("button", { name: "创建", exact: true })
			.click();
		await expect
			.poll(() => pollsAfterCreate, { timeout: 12000 })
			.toBeGreaterThanOrEqual(2);
		expect(held).toBe(true);
		release();
		if (isMobile)
			await expect(selected).toHaveValue(new RegExp(created.name), {
				timeout: 10000,
			});
		else await expect(selected).toContainText(created.name, { timeout: 10000 });
		await expect(
			page.getByRole("button", { name: "上传文档", exact: true }),
		).toBeEnabled();
		await page.screenshot({
			path: testInfo.outputPath("created-library.png"),
			animations: "disabled",
		});
	} finally {
		release();
	}
});

for (const refreshFailure of ["delayed", "unavailable"] as const) {
	test(`confirmed creation selects the new upload target before a ${refreshFailure} list refresh and preserves it after recovery`, async ({
		page,
		isMobile,
	}) => {
		const stamp = "2026-01-01T00:00:00.000Z";
		const existing: ApiLibrary = {
			id: "create-target-a",
			name: "Existing library A",
			status: "ready",
			doc_count: 1,
			ready_count: 1,
			created_at: stamp,
			updated_at: stamp,
		};
		const created: ApiLibrary = {
			...existing,
			id: "create-target-b",
			name: "Created library B",
			status: "empty",
			doc_count: 0,
			ready_count: 0,
		};
		const documents = new Map<string, ApiDocument[]>([
			[
				existing.id,
				[
					{
						id: "existing-target-document",
						library_id: existing.id,
						name: "Existing A document",
						filename: "existing-a.txt",
						content_type: "text/plain",
						status: "ready",
						chunk_count: 1,
						created_at: stamp,
						updated_at: stamp,
					},
				],
			],
			[created.id, []],
		]);
		let createCount = 0;
		let postCreateReads = 0;
		let successfulRefreshes = 0;
		let refreshState: "delayed" | "unavailable" | "recovered" = refreshFailure;
		function deferred() {
			let release = () => {};
			const promise = new Promise<void>((resolve) => {
				release = resolve;
			});
			return { promise, release };
		}
		const pending = deferred();
		const oldList = deferred();
		let holdOldList = false;
		let oldListStarted = false;
		let oldListFinished = false;
		const submissions: { libraryId: string; filename: string }[] = [];
		await page.route("**/api/libraries", async (route) => {
			if (route.request().method() === "POST") {
				expect(route.request().postDataJSON()).toMatchObject({
					name: created.name,
				});
				createCount += 1;
				await route.fulfill({ status: 201, json: created });
				return;
			}
			if (createCount === 0) {
				if (holdOldList) {
					oldListStarted = true;
					await oldList.promise;
					await route.fulfill({ json: [existing] }).catch(() => {});
					oldListFinished = true;
				} else {
					await route.fulfill({ json: [existing] });
				}
				return;
			}
			postCreateReads += 1;
			if (refreshState === "delayed") await pending.promise;
			if (refreshState === "unavailable") {
				await route.fulfill({
					status: 503,
					json: { detail: "fixture post-create library refresh unavailable" },
				});
				return;
			}
			await route
				.fulfill({
					json: [existing, created].map((library) => ({
						...library,
						status: documents.get(library.id)?.length ? "ready" : "empty",
						doc_count: documents.get(library.id)?.length ?? 0,
						ready_count: documents.get(library.id)?.length ?? 0,
					})),
				})
				.then(() => {
					successfulRefreshes += 1;
				})
				.catch(() => {});
		});
		await page.route("**/api/libraries/*/documents", async (route) => {
			const request = route.request();
			const libraryId = new URL(request.url()).pathname.split("/")[3];
			if (request.method() === "GET") {
				await route.fulfill({ json: documents.get(libraryId) ?? [] });
				return;
			}
			const form = await new Response(
				new Uint8Array(request.postDataBuffer() ?? []),
				{
					headers: { "Content-Type": request.headers()["content-type"] },
				},
			).formData();
			const file = form.get("file");
			if (!(file instanceof File))
				throw new Error("Expected a real multipart file upload");
			expect(await file.text()).toBe("Created library upload target fixture");
			submissions.push({ libraryId, filename: file.name });
			const document: ApiDocument = {
				id: `created-target-${file.name}`,
				library_id: libraryId,
				name: file.name,
				filename: file.name,
				content_type: "text/plain",
				status: "ready",
				chunk_count: 1,
				created_at: stamp,
				updated_at: stamp,
			};
			documents.get(libraryId)?.push(document);
			const result: ApiUploadResponse = {
				library_id: libraryId,
				doc_id: document.id,
				title: document.name,
				filename: file.name,
				chunk_count: 1,
				status: "ready",
				accepted: false,
				mode: "live",
				simulated: false,
			};
			await route.fulfill({ json: result });
		});
		async function expectSelected(library: ApiLibrary, label = library.name) {
			if (isMobile) {
				await expect(
					page.getByRole("combobox", { name: "当前知识库", exact: true }),
				).toHaveValue(label);
			} else {
				await expect(page.getByRole("heading", { level: 3 })).toContainText(
					library.name,
				);
				await expect(
					page
						.getByRole("complementary", { name: "知识库导航" })
						.getByRole("button", { name: new RegExp(library.name) }),
				).toHaveAttribute("aria-current", "true");
			}
		}
		const dialog = page.getByRole("dialog");
		const upload = page.getByRole("button", { name: "上传文档", exact: true });
		const refreshError = page
			.getByRole("alert")
			.filter({ hasText: "知识库加载失败" });
		async function uploadFile(filename: string) {
			const chooser = page.waitForEvent("filechooser");
			await upload.click();
			await (await chooser).setFiles({
				name: filename,
				mimeType: "text/plain",
				buffer: Buffer.from("Created library upload target fixture"),
			});
			const results = page.getByRole("region", { name: "本次上传结果" });
			await expect(results).toContainText(created.name);
			await expect(results).toContainText(filename);
			await expect(results).toContainText("已就绪");
		}
		try {
			await page.goto("/app/libraries");
			await expectSelected(existing);
			await expect(
				page.getByRole("button", { name: "Existing A document", exact: true }),
			).toBeVisible();
			holdOldList = true;
			await page.getByRole("button", { name: "刷新文档", exact: true }).click();
			await expect.poll(() => oldListStarted).toBe(true);
			await page
				.getByRole("button", { name: "新建知识库", exact: true })
				.first()
				.click();
			await dialog
				.getByRole("textbox", { name: "名称", exact: true })
				.fill(created.name);
			await dialog.getByRole("button", { name: "创建", exact: true }).click();
			await expect(dialog).toBeHidden();
			await expect.poll(() => postCreateReads).toBeGreaterThan(0);
			if (refreshFailure === "unavailable")
				await expect(refreshError).toBeVisible();
			expect(successfulRefreshes).toBe(0);
			await expectSelected(created, `${created.name} · 空`);
			oldList.release();
			await expect.poll(() => oldListFinished).toBe(true);
			await expectSelected(created, `${created.name} · 空`);
			await expect(upload).toBeEnabled();
			await uploadFile("before-refresh.txt");
			expect(submissions).toEqual([
				{ libraryId: created.id, filename: "before-refresh.txt" },
			]);
			await expect.poll(() => postCreateReads).toBeGreaterThanOrEqual(2);
			expect(successfulRefreshes).toBe(0);
			expect(createCount).toBe(1);
			await expect(dialog).toBeHidden();
			await expectSelected(created, `${created.name} · 空`);
			if (refreshFailure === "unavailable") {
				await expect(upload).toBeEnabled();
				await expect(refreshError).toBeVisible();
			}
			refreshState = "recovered";
			pending.release();
			await expect(upload).toBeEnabled();
			await expect(
				page.getByRole("button", { name: "before-refresh.txt", exact: true }),
			).toBeVisible();
			const recovered = page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === "/api/libraries" &&
					response.request().method() === "GET" &&
					response.status() === 200,
			);
			await page.getByRole("button", { name: "刷新文档", exact: true }).click();
			await recovered;
			await expect(refreshError).toHaveCount(0);
			await expectSelected(created);
			await expect(dialog).toBeHidden();
			await uploadFile("after-recovery.txt");
			await expect(upload).toBeEnabled();
			expect(createCount).toBe(1);
			expect(submissions).toEqual([
				{ libraryId: created.id, filename: "before-refresh.txt" },
				{ libraryId: created.id, filename: "after-recovery.txt" },
			]);
			await expectSelected(created);
		} finally {
			oldList.release();
			pending.release();
		}
	});
}

test("PDF detail shows observed parser phases without inventing upstream compute time", async ({
	page,
}, testInfo) => {
	const stamp = "2026-01-01T00:00:00.000Z";
	const library: ApiLibrary = {
		id: "timing-library",
		name: "Timing fixture",
		status: "ready",
		doc_count: 1,
		ready_count: 1,
		created_at: stamp,
		updated_at: stamp,
	};
	const report = {
		parser: "mineru",
		backend: "typescript",
		metrics: {
			provider: "302ai",
			external_data_processing: true,
			parser_timing: {
				schema_version: 1,
				analysis_ms: 50,
				submission_ms: 100,
				provider_wait_ms: 2000,
				result_fetch_ms: 300,
				poll_count: 3,
				retry_count: 1,
			},
		},
	};
	const document: ApiDocument = {
		id: "timing-document",
		library_id: library.id,
		name: "timed.pdf",
		filename: "timed.pdf",
		content_type: "application/pdf",
		status: "ready",
		chunk_count: 2,
		job_id: "timing-job",
		parser_report: report,
		has_file: true,
		created_at: stamp,
		updated_at: stamp,
	};
	const job: ApiJob = {
		id: "timing-job",
		type: "document.ingest",
		status: "completed",
		stage: "done",
		progress: 100,
		attempt: 1,
		max_attempts: 5,
		document_id: document.id,
		document_version_id: "timing-version",
		generation_id: "timing-generation",
		library_id: library.id,
		created_at: stamp,
		updated_at: stamp,
		parser_report: report,
		started_at: stamp,
		finished_at: "2026-01-01T00:00:03.000Z",
		stage_runs: [],
	};
	await page.route("**/api/libraries", (route) =>
		route.fulfill({ json: [library] }),
	);
	await page.route("**/api/libraries/*/documents", (route) =>
		route.fulfill({ json: [document] }),
	);
	await page.route("**/api/libraries/*/documents/*/versions", (route) =>
		route.fulfill({ json: [] }),
	);
	await page.route("**/api/jobs/timing-job", (route) =>
		route.fulfill({ json: job }),
	);
	await page.goto("/app/libraries");
	await page.getByRole("button", { name: "timed.pdf", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByText("任务等待（含轮询）", { exact: true }),
	).toBeVisible();
	await expect(
		dialog.getByText("结果获取与转换", { exact: true }),
	).toBeVisible();
	await expect(dialog.getByText("上游推理耗时", { exact: true })).toHaveCount(
		0,
	);
	await expect
		.poll(() => dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
		.toBe(true);
	await page.screenshot({
		path: testInfo.outputPath("parser-timing.png"),
		animations: "disabled",
	});
});
