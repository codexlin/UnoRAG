import { expect, type Page, test } from "@playwright/test";
import {
	partialModelUsage,
	reportedModelUsage,
	unavailableModelUsage,
	unusedModelUsage,
} from "../fixtures/model-usage";
import { chooseSelect } from "./select-helpers";

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

test("overview preserves unknown and stale health, exposes keyboard errors and fits narrow screens", async ({
	page,
}, testInfo) => {
	await signIn(page);
	const snapshot = await page.evaluate(async () => {
		const response = await fetch("/api/workspace/operations");
		if (!response.ok) throw new Error("operations fixture scope unavailable");
		return response.json();
	});
	let ready: (() => void) | undefined;
	let fail = false;
	const gate = new Promise<void>((resolve) => {
		ready = resolve;
	});
	const fixture = {
		...snapshot,
		overall: { status: "healthy", stale: false, evaluated_at: startedAt },
		ask: {
			...snapshot.ask,
			total: 10,
			completed: 8,
			refused: 1,
			failed: 1,
			cancelled: 0,
			running: 0,
			without_citations: 0,
			latency_ms: { p50: 2000, p95: 8000 },
			stage_latency_ms: [
				{ stage: "retrieve", count: 10, failed: 0, p50: 200, p95: 400 },
			],
		},
		components: [
			{
				code: "rerank",
				label: "Rerank",
				kind: "ai",
				status: "healthy",
				mode: "configuration",
				latency_ms: null,
				error_code: null,
				recovery: "等待下次健康检查",
				checked_at: startedAt,
				last_success_at: null,
				stale: false,
			},
		],
		alerts: [],
		recent_errors: [
			{
				id: firstId,
				resource_id: firstId,
				source: "ask",
				status: "failed",
				error_code: "provider_timeout",
				occurred_at: startedAt,
				job_type: null,
				stage: "generate",
				attempt: null,
			},
		],
	};
	await page.route("**/api/workspace/operations", async (route) => {
		await gate;
		await route.fulfill({
			status: fail ? 503 : 200,
			json: fail ? { detail: "unavailable" } : fixture,
		});
	});
	await page.route(
		`**/api/workspace/operations/events/ask/${firstId}`,
		(route) => route.fulfill({ json: detail() }),
	);
	await page.goto("/app/operations");
	const metrics = page.getByRole("region", { name: "问答指标", exact: true });
	await expect(metrics.getByText("--", { exact: true })).toHaveCount(5);
	await expect(
		page
			.getByRole("region", { name: "任务队列", exact: true })
			.getByText("--", { exact: true }),
	).toHaveCount(6);
	ready?.();
	await expect(metrics.getByText("10", { exact: true })).toBeVisible();
	await page.getByRole("switch", { name: "30s 自动刷新" }).uncheck();
	const health = page.getByRole("region", { name: "运行状态", exact: true });
	await expect(health).toContainText("运行稳定");
	const component = page.getByRole("region", { name: "组件健康", exact: true });
	await expect(component.getByText("配置就绪", { exact: true })).toBeVisible();
	for (const [status, stale, label] of [
		["healthy", true, "状态已过期"],
		["degraded", false, "需要关注"],
		["unavailable", false, "服务不可用"],
		["unknown", false, "状态未知"],
	] as const) {
		fixture.overall = { status, stale, evaluated_at: startedAt };
		fixture.components[0].stale = true;
		await page
			.getByRole("button", { name: "刷新运行数据", exact: true })
			.click();
		await expect(health).toContainText(label);
		await expect(health).not.toContainText("运行稳定");
		await expect(
			component.getByText("探测已过期", { exact: true }),
		).toBeVisible();
		await expect(component.getByText("配置就绪", { exact: true })).toHaveCount(
			0,
		);
	}
	fail = true;
	await page.getByRole("button", { name: "刷新运行数据", exact: true }).click();
	const refreshError = page
		.getByRole("alert")
		.filter({ hasText: "上一次成功快照" });
	await expect(refreshError).toBeVisible();
	await expect(metrics.getByText("10", { exact: true })).toBeVisible();
	fail = false;
	fixture.overall = {
		status: "healthy",
		stale: false,
		evaluated_at: startedAt,
	};
	fixture.components[0].stale = false;
	await page.getByRole("button", { name: "刷新运行数据", exact: true }).click();
	await expect(health).toContainText("运行稳定");
	await expect(refreshError).toHaveCount(0);
	const errorButton = page.getByRole("button", {
		name: `查看请求错误 ${firstId}`,
		exact: true,
	});
	await errorButton.focus();
	await page.keyboard.press("Enter");
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByRole("heading", { name: "请求链路", exact: true }),
	).toBeFocused();
	await expect(
		dialog.getByRole("heading", { name: "阶段耗时", exact: true }),
	).toBeVisible();
	await expect(
		dialog.getByText("3 步 · 顺序累计", { exact: true }),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(errorButton).toBeFocused();
	for (const width of [320, 390, 768, 1024, 1440]) {
		await page.setViewportSize({ width, height: 1000 });
		await expectFits(page);
		const bounds = await page
			.getByRole("button", { name: "刷新运行数据", exact: true })
			.boundingBox();
		const minTarget = width < 768 ? 44 : 36;
		expect(bounds?.width).toBeGreaterThanOrEqual(minTarget);
		expect(bounds?.height).toBeGreaterThanOrEqual(minTarget);
	}
	await page.screenshot({
		path: testInfo.outputPath("operations-overview.png"),
		fullPage: true,
	});
});

test("model token usage distinguishes reported, partial, unknown, unused and legacy requests", async ({
	page,
}, testInfo) => {
	await signIn(page);
	const scenarios = [
		{ name: "reported", usage: reportedModelUsage, label: "已上报" },
		{ name: "partial", usage: partialModelUsage, label: "部分已知" },
		{ name: "unknown", usage: unavailableModelUsage, label: "用量未知" },
		{ name: "unused", usage: unusedModelUsage, label: "未调用 LLM" },
		{ name: "legacy", usage: undefined, label: "未记录" },
		{
			name: "truncated",
			usage: { ...partialModelUsage, truncated: true },
			label: "部分已知",
		},
	].map((scenario, index) => ({
		...scenario,
		id: `a1000000-0000-4000-8000-00000000001${index}`,
		request: `a2000000-0000-4000-8000-00000000001${index}`,
	}));
	await page.route("**/api/workspace/operations/requests?**", (route) =>
		route.fulfill({
			json: {
				items: scenarios.map(({ id, request }) => row(id, request)),
				next_cursor: null,
				window: { from: startedAt, to: startedAt },
			},
		}),
	);
	await page.route("**/api/workspace/operations/events/ask/*", (route) => {
		const scenario = scenarios.find(({ id }) =>
			route.request().url().endsWith(id),
		);
		if (!scenario) throw new Error("unexpected model usage fixture request");
		const payload = detail(scenario.id, scenario.request);
		return route.fulfill({
			json: {
				...payload,
				ask: { ...payload.ask, model_usage: scenario.usage },
			},
		});
	});
	await page.goto("/app/operations");
	await page.getByRole("button", { name: "请求记录", exact: true }).click();
	for (const scenario of scenarios) {
		await page
			.getByRole("button", {
				name: `查看请求 ${scenario.request}`,
				exact: true,
			})
			.click();
		const panel = page.getByRole("region", { name: "模型 Token 用量" });
		await expect(
			panel.getByText(scenario.label, { exact: true }),
		).toBeVisible();
		await expect(panel).toContainText("仅 LLM，不含 Embedding / Rerank");
		const totals = panel.locator("dl").first();
		if (scenario.name === "reported") {
			await expect(totals.locator("dd")).toHaveText(["2,000", "200", "2,200"]);
			await expect(panel.getByText(/缓存输入 400/)).toBeVisible();
			await expect(panel).toContainText("包含在输入内");
			await expect(panel).not.toContainText("2,600");
			await expect(panel.getByText(/^generation-long-model-/)).toBeVisible();
			await expect(panel.getByText(/^provider-long-provider-/)).toBeVisible();
		} else if (scenario.name === "partial" || scenario.name === "truncated") {
			await expect(totals.locator("dt")).toHaveText([
				"已知输入",
				"已知输出",
				"已知合计",
			]);
			await expect(totals.locator("dd")).toHaveText(["800", "未知", "未知"]);
			await expect(panel).toContainText("不是完整请求总量");
			await expect(panel.getByRole("listitem")).toHaveCount(3);
			await expect(panel).toContainText("失败 · 用量未知");
			await expect(panel).toContainText("尝试 2");
			await expect(panel).toContainText("已取消 · 用量未知");
			if (scenario.name === "truncated")
				await expect(panel).toContainText("调用记录已截断");
		} else if (scenario.name === "unknown") {
			await expect(totals.locator("dd")).toHaveText(["未知", "未知", "未知"]);
			const identity = panel.getByRole("listitem").locator("dl").first();
			await expect(identity.locator("dd")).toHaveText(["未知", "未知"]);
		} else {
			await expect(panel.locator("dl")).toHaveCount(0);
			await expect(panel.getByRole("list")).toHaveCount(0);
			await expect(panel).toContainText(
				scenario.name === "legacy" ? "不能视为零消耗" : "此请求未调用 LLM",
			);
		}
		await panel.scrollIntoViewIfNeeded();
		expect(
			await panel.evaluate(
				(element) => element.scrollWidth <= element.clientWidth + 1,
			),
		).toBe(true);
		await expectFits(page);
		await page.screenshot({
			path: testInfo.outputPath(`model-usage-${scenario.name}.png`),
			fullPage: true,
		});
		await page.keyboard.press("Escape");
	}
});

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
	await page.getByRole("button", { name: "下一页", exact: true }).click();
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
	await chooseSelect(
		page.getByRole("combobox", { name: "时间范围", exact: true }),
		"最近 7 天",
	);
	await chooseSelect(
		page.getByRole("combobox", { name: "请求状态", exact: true }),
		"已完成",
	);
	await chooseSelect(
		page.getByRole("combobox", { name: "问题类型", exact: true }),
		"事实",
	);
	await page.getByLabel("最低耗时(ms)", { exact: true }).fill("15000");
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
