import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import type {
	ApiDocument,
	ApiDocumentVersion,
	ApiJob,
	ApiLibrary,
} from "../../src/lib/api";

test.setTimeout(60_000);

const stamp = "2026-01-01T00:00:00.000Z";
const library: ApiLibrary = {
	id: "detail-library",
	name: "Document details fixture",
	status: "ready",
	doc_count: 1,
	ready_count: 0,
	created_at: stamp,
	updated_at: stamp,
};
const document: ApiDocument = {
	id: "detail-document",
	library_id: library.id,
	name: "版本关系核对",
	filename: `${"long-source-filename-".repeat(10)}.pdf`,
	content_type: "application/pdf",
	status: "failed",
	chunk_count: 0,
	size_bytes: 10240,
	has_file: true,
	job_id: "detail-job",
	job_status: "failed",
	job_stage: "parsing",
	job_progress: 23,
	parser_report: {
		parser: "mineru",
		partial: true,
		failed_pages: [2],
		needs_ocr_pages: [3],
		warnings: ["Error: parser fixture diagnostic"],
	},
	parse_status: {
		parser_label: "MinerU",
		external_processing: true,
		task_status: "解析失败",
		provider_task_id: `provider-${"0123456789".repeat(10)}`,
		degrade_reason: "部分页不可用",
		parse_quality_hint: "请核对缺失页面",
	},
	created_at: stamp,
	updated_at: stamp,
};
const active: ApiDocumentVersion = {
	id: "detail-v1",
	version: 1,
	generation_id: "generation-old-active",
	status: "active",
	is_active: true,
	is_desired: false,
	content_hash: "fixture-hash-1",
	chunk_count: 12,
	activated_at: stamp,
	created_at: stamp,
	updated_at: stamp,
};
const desired: ApiDocumentVersion = {
	...active,
	id: "detail-v2",
	version: 2,
	generation_id: "generation-new-failed",
	status: "failed",
	is_active: false,
	is_desired: true,
	chunk_count: 0,
	failure_code: "parser_failed",
	activated_at: null,
};
const job: ApiJob = {
	id: "detail-job",
	type: "document.ingest",
	status: "failed",
	stage: "parsing",
	progress: 23,
	attempt: 2,
	max_attempts: 5,
	document_id: document.id,
	document_version_id: desired.id,
	generation_id: desired.generation_id,
	library_id: library.id,
	error_code: "parser_failed",
	error: "Provider result unavailable",
	parser_report: {
		metrics: {
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
	},
	stage_runs: [],
	created_at: stamp,
	updated_at: stamp,
};

async function login(page: Page) {
	const email = process.env.UNORAG_E2E_ADMIN_EMAIL;
	const password = process.env.UNORAG_E2E_ADMIN_PASSWORD;
	if (!email || !password)
		throw new Error("E2E administrator credentials required");
	const response = await page.request.post("/api/auth/session", {
		data: { email, password },
	});
	expect(response.ok()).toBe(true);
	const identity = await response.json();
	expect(identity.mustChangePassword).toBe(false);
	expect(["owner", "admin"]).toContain(identity.role);
}

async function mockDetails(
	page: Page,
	doc: ApiDocument,
	versions: ApiDocumentVersion[],
	currentJob: ApiJob | null,
) {
	await page.route("**/api/libraries", (route) =>
		route.fulfill({ json: [library] }),
	);
	await page.route(/\/api\/libraries\/[^/]+\/documents(?:\?.*)?$/, (route) =>
		route.fulfill({ json: [doc] }),
	);
	await page.route(
		/\/api\/libraries\/[^/]+\/documents\/[^/?]+(?:\?.*)?$/,
		(route) => route.fulfill({ json: doc }),
	);
	await page.route("**/api/libraries/*/documents/*/versions", (route) =>
		route.fulfill({
			json: {
				active_version_id:
					versions.find((version) => version.is_active)?.id ?? null,
				desired_version_id:
					versions.find((version) => version.is_desired)?.id ?? null,
				versions,
			},
		}),
	);
	await page.route("**/api/jobs/*", (route) =>
		route.fulfill({ json: currentJob }),
	);
}

test("detail separates an active version from a failed target and preserves diagnostics and focus", async ({
	page,
}, testInfo) => {
	test.setTimeout(90_000);
	await login(page);
	await mockDetails(page, document, [desired, active], job);
	await page.goto("/app/libraries");
	const trigger = page.getByRole("button", {
		name: document.name,
		exact: true,
	});
	await trigger.click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByRole("heading", { name: document.name, exact: true }),
	).toBeFocused();
	await expect(
		dialog.getByText("v1 仍为生效版本；目标 v2 尚未生效。", { exact: true }),
	).toBeVisible();
	const task = dialog.getByRole("region", { name: "当前处理任务" });
	await expect(task.getByText("失败", { exact: true })).toBeVisible();
	await expect(task.getByText("23%", { exact: true })).toBeVisible();
	await expect(task.getByText("2 / 5", { exact: true })).toBeVisible();
	await expect(
		task.getByText("任务等待（含轮询）", { exact: true }),
	).toBeVisible();
	await expect(task.getByText("执行耗时", { exact: true })).toHaveCount(0);
	await expect(task.getByText("上游推理耗时", { exact: true })).toHaveCount(0);
	await expect(
		task.getByText("顺序累计耗时，非绝对时间轴", { exact: true }),
	).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: "重试任务", exact: true }),
	).toBeEnabled();
	await expect(
		dialog.getByRole("button", { name: "取消任务", exact: true }),
	).toHaveCount(0);
	for (const name of ["谁可见", "替换文件", "重索引", "下载", "删除"]) {
		await expect(
			dialog.getByRole("button", { name, exact: true }),
		).toBeVisible();
	}
	await page.screenshot({
		path: testInfo.outputPath("detail-overview.png"),
		animations: "disabled",
	});
	const diagnostics = dialog.getByRole("region", { name: "解析诊断" });
	await diagnostics.getByText("技术详情", { exact: true }).click();
	await expect(
		diagnostics.getByText("Error: parser fixture diagnostic", { exact: true }),
	).toBeVisible();
	await expect(
		diagnostics.getByText("部分页未解析（失败页 2）", { exact: true }),
	).toBeVisible();
	await expect(
		diagnostics.getByText("建议 OCR 页：3", { exact: true }),
	).toBeVisible();
	await expect(
		diagnostics.getByText("已出域处理", { exact: true }),
	).toBeVisible();
	await expect(
		diagnostics.getByText("请核对缺失页面", { exact: true }),
	).toBeVisible();

	for (const theme of ["light", "dark"]) {
		await page.evaluate((value) => {
			globalThis.document.documentElement.classList.toggle(
				"dark",
				value === "dark",
			);
			globalThis.document.documentElement.classList.toggle(
				"light",
				value === "light",
			);
		}, theme);
		for (const width of [320, 390, 768, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			await expect
				.poll(() =>
					dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
				)
				.toBe(true);
			await expect
				.poll(() =>
					dialog.getByRole("button").evaluateAll((buttons) =>
						buttons.every((button) => {
							const rect = button.getBoundingClientRect();
							return rect.width >= 44 && rect.height >= 44;
						}),
					),
				)
				.toBe(true);
			await expect
				.poll(() =>
					diagnostics.evaluate((el) =>
						Array.from(el.querySelectorAll("p, li, summary")).every(
							(node) =>
								Number.parseFloat(getComputedStyle(node).fontSize) >= 12,
						),
					),
				)
				.toBe(true);
			await page.screenshot({
				path: testInfo.outputPath(`detail-${theme}-${width}.png`),
				animations: "disabled",
			});
		}
	}
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(trigger).toBeFocused();
	await trigger.click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "关闭", exact: true })
		.click();
	await expect(trigger).toBeFocused();
});

test("detail does not invent active versions, completed jobs or retained files from document status", async ({
	page,
}) => {
	await login(page);
	await mockDetails(
		page,
		{
			...document,
			status: "ready",
			has_file: undefined,
			job_id: null,
			job_status: null,
			job_stage: null,
			job_progress: null,
			parser_report: null,
			parse_status: null,
		},
		[],
		null,
	);
	await page.goto("/app/libraries");
	await page.getByRole("button", { name: document.name, exact: true }).click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByText("未设置生效版本", { exact: true }),
	).toBeVisible();
	await expect(dialog.getByText("保留状态未知", { exact: true })).toBeVisible();
	await expect(dialog.getByText("暂无关联任务", { exact: true })).toBeVisible();
	await expect(
		dialog.getByText("未取得版本记录", { exact: true }),
	).toBeVisible();
	await expect(dialog.getByText("暂无解析报告", { exact: true })).toBeVisible();
	await expect(dialog.getByText("已完成", { exact: true })).toHaveCount(0);
	await expect(dialog.getByText("任务进度", { exact: true })).toHaveCount(0);
	await expect(
		dialog.getByRole("button", { name: "下载", exact: true }),
	).toBeDisabled();
});

test("version pointers remain authoritative when the history list omits the active version", async ({
	page,
}) => {
	await login(page);
	await mockDetails(page, document, [desired], job);
	await page.route("**/api/libraries/*/documents/*/versions", (route) =>
		route.fulfill({
			json: {
				active_version_id: active.id,
				desired_version_id: desired.id,
				versions: [{ ...desired, is_active: true }],
			},
		}),
	);
	await page.goto("/app/libraries");
	await page.getByRole("button", { name: document.name, exact: true }).click();
	const dialog = page.getByRole("dialog");
	const overview = dialog.getByRole("region", { name: "版本概览" });
	await expect(
		overview.getByText("生效版本未在当前列表中", { exact: true }),
	).toBeVisible();
	await expect(overview.getByText(active.id, { exact: true })).toBeVisible();
	await expect(
		overview.getByText("已有版本 仍为生效版本；目标 v2 尚未生效。", {
			exact: true,
		}),
	).toBeVisible();
	await expect(dialog.getByText(/不可.*检索/)).toHaveCount(0);
	const history = dialog.getByRole("region", { name: "版本历史" });
	await expect(history.getByText("当前生效", { exact: true })).toHaveCount(0);
	await expect(history.getByText("目标版本", { exact: true })).toBeVisible();
});

test("version read errors have an alert and an in-place retry without losing the document", async ({
	page,
}) => {
	await login(page);
	await mockDetails(page, document, [desired, active], job);
	let failing = true;
	let reads = 0;
	await page.route("**/api/libraries/*/documents/*/versions", (route) => {
		reads += 1;
		return failing
			? route.fulfill({
					status: 503,
					json: { detail: "fixture versions unavailable" },
				})
			: route.fulfill({
					json: {
						active_version_id: active.id,
						desired_version_id: desired.id,
						versions: [desired, active],
					},
				});
	});
	await page.goto("/app/libraries");
	await page.getByRole("button", { name: document.name, exact: true }).click();
	const dialog = page.getByRole("dialog");
	const overview = dialog.getByRole("region", { name: "版本概览" });
	await expect(overview.getByRole("alert")).toHaveText(
		"版本信息读取失败，当前版本关系尚未确认。",
	);
	await expect(
		overview.getByText("未设置生效版本", { exact: true }),
	).toHaveCount(0);
	await expect(overview.getByText(/不可.*检索/)).toHaveCount(0);
	const beforeRetry = reads;
	failing = false;
	await overview
		.getByRole("button", { name: "重试读取版本", exact: true })
		.click();
	await expect(overview.getByRole("alert")).toHaveCount(0);
	await expect(
		overview.getByText("v1 仍为生效版本；目标 v2 尚未生效。", { exact: true }),
	).toBeVisible();
	expect(reads).toBeGreaterThan(beforeRetry);
	await expect(
		dialog.getByRole("heading", { name: document.name, exact: true }),
	).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: "下载", exact: true }),
	).toBeEnabled();
});

test("detail cancel and retry reuse existing handlers and task visibility rules", async ({
	page,
}) => {
	await login(page);
	const currentDocument = {
		...document,
		status: "processing",
		job_status: "running",
	};
	const currentJob = {
		...job,
		status: "running",
		error: null,
		error_code: null,
	};
	const currentDesired = { ...desired };
	await mockDetails(
		page,
		currentDocument,
		[currentDesired, active],
		currentJob,
	);
	let cancels = 0;
	let retries = 0;
	await page.route("**/api/jobs/detail-job/cancel", (route) => {
		expect(route.request().method()).toBe("POST");
		cancels += 1;
		currentDocument.job_status = "cancelling";
		currentJob.status = "cancelling";
		return route.fulfill({ status: 202, json: currentJob });
	});
	await page.route("**/api/jobs/detail-job/retry", (route) => {
		expect(route.request().method()).toBe("POST");
		retries += 1;
		currentDocument.status = "processing";
		currentDocument.job_status = "queued";
		currentDocument.job_stage = "accepted";
		currentDocument.job_progress = 0;
		currentDocument.parser_report = null;
		currentJob.id = "detail-retry-job";
		currentJob.generation_id = "generation-retry";
		currentJob.status = "queued";
		currentJob.stage = "accepted";
		currentJob.progress = 0;
		currentJob.attempt = 0;
		currentJob.parser_report = null;
		currentDocument.job_id = currentJob.id;
		currentDesired.status = "pending";
		currentDesired.generation_id = currentJob.generation_id;
		return route.fulfill({ status: 202, json: currentJob });
	});
	async function open() {
		await page.goto("/app/libraries");
		await page
			.getByRole("button", { name: document.name, exact: true })
			.click();
		return page.getByRole("dialog");
	}
	let dialog = await open();
	await expect(
		dialog.getByRole("button", { name: "重试任务", exact: true }),
	).toHaveCount(0);
	await dialog.getByRole("button", { name: "取消任务", exact: true }).click();
	await expect(
		dialog.getByRole("button", { name: "取消任务", exact: true }),
	).toBeDisabled();
	await expect.poll(() => cancels).toBe(1);
	currentDocument.status = "degraded";
	currentDocument.job_status = "cancelled";
	currentJob.status = "cancelled";
	dialog = await open();
	await expect(
		dialog.getByRole("button", { name: "取消任务", exact: true }),
	).toHaveCount(0);
	await dialog.getByRole("button", { name: "重试任务", exact: true }).click();
	await expect.poll(() => retries).toBe(1);
	await expect(
		dialog.getByRole("button", { name: "取消任务", exact: true }),
	).toBeEnabled();
	await expect(
		dialog
			.getByRole("region", { name: "当前处理任务" })
			.getByText("detail-retry-job", { exact: true }),
	).toBeVisible();
	currentDocument.status = "degraded";
	currentDocument.job_status = "dead";
	currentDocument.has_file = false;
	currentJob.status = "dead";
	dialog = await open();
	await expect(
		dialog.getByRole("button", { name: "重试任务", exact: true }),
	).toBeDisabled();
	await expect(
		dialog.getByRole("button", { name: "取消任务", exact: true }),
	).toHaveCount(0);
	currentDocument.status = "ready";
	currentDocument.job_status = "completed";
	currentJob.status = "completed";
	dialog = await open();
	await expect(
		dialog.getByRole("button", { name: "重试任务", exact: true }),
	).toHaveCount(0);
	await expect(
		dialog.getByRole("button", { name: "取消任务", exact: true }),
	).toHaveCount(0);
	expect(cancels).toBe(1);
	expect(retries).toBe(1);
});

test("read-only members see download but no cancel or retry for either running or failed tasks", async ({
	page,
	playwright,
}) => {
	test.setTimeout(90_000);
	await login(page);
	const admin = await playwright.request.newContext({
		baseURL: test.info().project.use.baseURL,
		storageState: await page.context().storageState(),
	});
	let viewerId: string | null = null;
	let inviteId: string | null = null;
	try {
		const invited = await admin.post("/api/workspace/invites", {
			data: {
				email: `detail-viewer-${randomUUID()}@example.test`,
				role: "viewer",
				send_email: false,
			},
		});
		expect(invited.ok()).toBe(true);
		const invite = await invited.json();
		inviteId = invite.id;
		const inviteUrl = new URL(
			invite.inviteUrl,
			test.info().project.use.baseURL,
		);
		const token = new URLSearchParams(inviteUrl.hash.slice(1)).get("token");
		expect(token).toBeTruthy();
		await page.context().clearCookies();
		const accepted = await page.request.post("/api/auth/invite", {
			data: {
				token,
				password: `DetailPass-${randomUUID()}`,
				display_name: "Detail E2E viewer",
			},
		});
		expect(accepted.ok()).toBe(true);
		const viewer = await accepted.json();
		viewerId = viewer.principalId;
		expect(viewer.role).toBe("viewer");
		expect(viewer.session_created).toBe(true);
		for (const status of ["running", "failed"]) {
			await mockDetails(
				page,
				{ ...document, job_status: status },
				[desired, active],
				{ ...job, status },
			);
			await page.goto("/app/libraries");
			await page
				.getByRole("button", { name: document.name, exact: true })
				.click();
			const dialog = page.getByRole("dialog");
			await expect(
				dialog.getByRole("button", { name: "下载", exact: true }),
			).toBeEnabled();
			for (const name of [
				"取消任务",
				"重试任务",
				"谁可见",
				"替换文件",
				"重索引",
				"删除",
			]) {
				await expect(
					dialog.getByRole("button", { name, exact: true }),
				).toHaveCount(0);
			}
		}
	} finally {
		try {
			if (viewerId) {
				await page.request.delete("/api/auth/session");
				const removed = await admin.delete("/api/workspace/members", {
					data: { user_id: viewerId },
				});
				expect(removed.ok()).toBe(true);
			} else if (inviteId) {
				await admin.delete(`/api/workspace/invites/${inviteId}`);
			}
		} finally {
			await admin.dispose();
		}
	}
});
