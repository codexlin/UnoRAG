import { expect, test } from "@playwright/test";
import type { ApiDocument, ApiJob, ApiLibrary } from "../../src/lib/api";

test("ingest polling cannot cancel the post-create refresh or lose library selection", async ({
	page,
	isMobile,
}, testInfo) => {
	const email = process.env.UNORAG_E2E_ADMIN_EMAIL;
	const password = process.env.UNORAG_E2E_ADMIN_PASSWORD;
	if (!email || !password)
		throw new Error("E2E administrator credentials required");
	await page.goto("/login");
	await page.getByLabel("邮箱").fill(email);
	await page.getByLabel("密码").fill(password);
	await page.getByRole("button", { name: "登录", exact: true }).click();
	await page.waitForURL((url) => url.pathname.startsWith("/app"));
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

test("PDF detail shows observed parser phases without inventing upstream compute time", async ({
	page,
}, testInfo) => {
	const email = process.env.UNORAG_E2E_ADMIN_EMAIL;
	const password = process.env.UNORAG_E2E_ADMIN_PASSWORD;
	if (!email || !password)
		throw new Error("E2E administrator credentials required");
	await page.goto("/login");
	await page.getByLabel("邮箱").fill(email);
	await page.getByLabel("密码").fill(password);
	await page.getByRole("button", { name: "登录", exact: true }).click();
	await page.waitForURL((url) => url.pathname.startsWith("/app"));
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
