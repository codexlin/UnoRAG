import { expect, type Page, test } from "@playwright/test";

const firstId = "a1000000-0000-4000-8000-000000000001";
const secondId = "a1000000-0000-4000-8000-000000000002";
const requestId = "a2000000-0000-4000-8000-000000000001";
const secondRequestId = "a2000000-0000-4000-8000-000000000002";

async function signIn(page: Page) {
	const email = process.env.UNORAG_E2E_ADMIN_EMAIL?.trim();
	const password = process.env.UNORAG_E2E_ADMIN_PASSWORD?.trim();
	if (!email || !password)
		throw new Error("E2E admin credentials are required");
	await page.goto("/login");
	await page.getByLabel("邮箱").fill(email);
	await page.getByLabel("密码").fill(password);
	await page.getByRole("button", { name: "登录", exact: true }).click();
	await page.waitForURL((url) => url.pathname.startsWith("/app"));
}

const startedAt = "2026-11-05T00:00:00.000Z";
const row = (id = firstId, request = requestId, status = "completed") => ({
	id,
	request_id: request,
	started_at: startedAt,
	ended_at: "2026-11-05T00:00:08.000Z",
	status,
	query_type: "fact",
	retrieval_mode: "dense",
	latency_ms: 8_000,
	citation_count: status === "completed" ? 2 : 0,
	library_id: "request-browser-fixture",
});

const detail = (id = firstId, request = requestId, status = "completed") => ({
	...row(id, request, status),
	source: "ask",
	error_code: null,
	guidance: {
		title: "Unclassified fixture",
		cause: "must not appear on success",
		recovery: "must not appear on success",
	},
	otel_trace_id: null,
	workflow_id: null,
	document_id: null,
	document_version_id: null,
	message: null,
	ask: {
		refuse_reason: status === "refused" ? "insufficient_evidence" : null,
		citation_count: status === "completed" ? 2 : 0,
		used_hybrid: false,
		used_rerank: false,
	},
	stages: ["retrieve", "judge", "generate"].map((stage, index) => ({
		id: `${id}-${stage}`,
		sequence: index + 1,
		attempt: null,
		stage,
		outcome: "completed",
		error_code: null,
		started_at: null,
		ended_at: null,
		duration_ms: [800, 2_000, 5_000][index],
	})),
});

async function expectFits(page: Page) {
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth + 1,
		),
	).toBe(true);
}

test("request browser filters, paginates and opens successful and refused chains", async ({
	page,
}, testInfo) => {
	await signIn(page);
	const calls: URL[] = [];
	let fail = false;
	await page.route("**/api/workspace/operations/requests?**", async (route) => {
		const url = new URL(route.request().url());
		calls.push(url);
		await route.fulfill({
			status: fail ? 503 : 200,
			json: fail
				? { detail: "unavailable" }
				: {
						items: url.searchParams.has("cursor")
							? [row(secondId, secondRequestId, "refused")]
							: [row()],
						next_cursor: url.searchParams.has("cursor")
							? null
							: "fixture-cursor",
						window: { from: "2026-11-04T00:00:00.000Z", to: startedAt },
					},
		});
	});
	await page.route(
		"**/api/workspace/operations/events/ask/*",
		async (route) => {
			const second = route.request().url().endsWith(secondId);
			await route.fulfill({
				json: second ? detail(secondId, secondRequestId, "refused") : detail(),
			});
		},
	);
	await page.goto("/app/operations");
	await page.getByRole("button", { name: "请求记录", exact: true }).click();
	await expect(
		page.getByRole("button", { name: `查看请求 ${requestId}`, exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: `查看请求 ${requestId}`, exact: true })
		.click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByRole("heading", { name: "请求链路", exact: true }),
	).toBeVisible();
	await expect(dialog.getByText("已完成", { exact: true })).toBeVisible();
	await expect(dialog.getByText("知识检索", { exact: true })).toBeVisible();
	await expect(dialog.getByText("答案生成", { exact: true })).toBeVisible();
	await expect(dialog.getByText("must not appear on success")).toHaveCount(0);
	await expectFits(page);
	await page.screenshot({
		path: testInfo.outputPath("successful-request-chain.png"),
		fullPage: true,
	});
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "下一页请求", exact: true }).click();
	await expect(
		page.getByRole("button", {
			name: `查看请求 ${secondRequestId}`,
			exact: true,
		}),
	).toBeVisible();
	await page
		.getByRole("button", { name: `查看请求 ${secondRequestId}`, exact: true })
		.click();
	await expect(dialog.getByText("已拒答", { exact: true })).toBeVisible();
	await expect(
		dialog.getByText("insufficient_evidence", { exact: true }),
	).toBeVisible();
	await expect(dialog.getByText("Unclassified fixture")).toHaveCount(0);
	await page.keyboard.press("Escape");
	await page
		.getByRole("combobox", { name: "时间范围", exact: true })
		.selectOption("7d");
	await page
		.getByRole("combobox", { name: "请求状态", exact: true })
		.selectOption("completed");
	await page
		.getByRole("combobox", { name: "问题类型", exact: true })
		.selectOption("fact");
	await page.getByLabel("最低耗时（ms）", { exact: true }).fill("15000");
	await page.getByLabel("Request ID", { exact: true }).fill(requestId);
	await page.getByRole("button", { name: "筛选", exact: true }).click();
	await expect
		.poll(() => calls.at(-1)?.searchParams.get("min_latency_ms"))
		.toBe("15000");
	const params = calls.at(-1)?.searchParams;
	expect(params?.get("range")).toBe("7d");
	expect(params?.get("request_id")).toBe(requestId);
	expect(params?.get("status")).toBe("completed");
	expect(params?.get("cursor")).toBeNull();
	await expectFits(page);
	await page.screenshot({
		path: testInfo.outputPath("request-records.png"),
		fullPage: true,
	});
	fail = true;
	await page.getByRole("button", { name: "刷新请求记录", exact: true }).click();
	await expect(
		page.getByRole("alert").filter({ hasText: "请求记录加载失败" }),
	).toBeVisible();
	fail = false;
	await page.getByRole("button", { name: "刷新请求记录", exact: true }).click();
	await expect(
		page.getByRole("alert").filter({ hasText: "请求记录加载失败" }),
	).toHaveCount(0);
});

test("late detail response cannot overwrite another selected request", async ({
	page,
}) => {
	await signIn(page);
	let release: (() => void) | undefined;
	let settled: (() => void) | undefined;
	const responseSettled = new Promise<void>((resolve) => {
		settled = resolve;
	});
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	let firstStarted = false;
	await page.route("**/api/workspace/operations/requests?**", async (route) => {
		await route.fulfill({
			json: {
				items: [row(), row(secondId, secondRequestId, "refused")],
				next_cursor: null,
				window: { from: startedAt, to: startedAt },
			},
		});
	});
	await page.route(
		"**/api/workspace/operations/events/ask/*",
		async (route) => {
			if (route.request().url().endsWith(firstId)) {
				firstStarted = true;
				await blocked;
				await route.fulfill({ json: detail() }).catch(() => {});
				settled?.();
			} else
				await route.fulfill({
					json: detail(secondId, secondRequestId, "refused"),
				});
		},
	);
	await page.goto("/app/operations");
	await page.getByRole("button", { name: "请求记录", exact: true }).click();
	await page
		.getByRole("button", { name: `查看请求 ${requestId}`, exact: true })
		.click();
	await expect.poll(() => firstStarted).toBe(true);
	await page.keyboard.press("Escape");
	await page
		.getByRole("button", { name: `查看请求 ${secondRequestId}`, exact: true })
		.click();
	await expect(
		page.getByRole("dialog").getByText("已拒答", { exact: true }),
	).toBeVisible();
	release?.();
	await responseSettled;
	await expect(
		page.getByRole("dialog").getByText(secondRequestId, { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("dialog").getByText(requestId, { exact: true }),
	).toHaveCount(0);
});

test("request endpoint exposes only scoped metadata over real authenticated HTTP", async ({
	page,
	request,
}) => {
	const anonymous = await request.get("/api/workspace/operations/requests");
	expect(anonymous.status()).toBe(401);
	await signIn(page);
	const response = await page.evaluate(async () => {
		const result = await fetch(
			"/api/workspace/operations/requests?range=24h&limit=1",
		);
		return {
			status: result.status,
			cacheControl: result.headers.get("cache-control"),
			body: await result.json(),
		};
	});
	expect(response.status).toBe(200);
	expect(response.cacheControl).toContain("no-store");
	const body = response.body;
	expect(Array.isArray(body.items)).toBe(true);
	for (const item of body.items) {
		expect(Object.keys(item).sort()).toEqual(
			[
				"id",
				"request_id",
				"started_at",
				"ended_at",
				"status",
				"query_type",
				"retrieval_mode",
				"latency_ms",
				"citation_count",
				"library_id",
			].sort(),
		);
	}
	const invalid = await page.evaluate(
		async () =>
			(await fetch("/api/workspace/operations/requests?status=unknown")).status,
	);
	expect(invalid).toBe(400);
});
