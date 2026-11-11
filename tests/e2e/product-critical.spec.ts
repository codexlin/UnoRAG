import { expect, type Page, test } from "@playwright/test";
import { errorGuidance } from "../../src/lib/error-diagnostics";

const email = process.env.UNORAG_E2E_ADMIN_EMAIL?.trim();
const password = process.env.UNORAG_E2E_ADMIN_PASSWORD?.trim();

async function expectNoHorizontalOverflow(page: Page) {
	await expect
		.poll(() =>
			page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth + 1,
			),
		)
		.toBe(true);
}

async function signIn(page: Page) {
	if (!email || !password) {
		throw new Error(
			"UNORAG_E2E_ADMIN_EMAIL and UNORAG_E2E_ADMIN_PASSWORD are required",
		);
	}
	await page.goto("/login");
	await page.getByLabel("邮箱").fill(email);
	await page.getByLabel("密码").fill(password);
	await page.getByRole("button", { name: "登录" }).click();
	await page.waitForURL((url) => url.pathname.startsWith("/app"));
}

test("public entry and authentication boundary are usable", async ({
	page,
}) => {
	const response = await page.goto("/");
	expect(response).not.toBeNull();
	const headers = response?.headers() ?? {};
	expect(headers["content-security-policy"]).toContain(
		"frame-ancestors 'none'",
	);
	expect(headers["content-security-policy"]).toContain("object-src 'none'");
	expect(headers["strict-transport-security"]).toContain("max-age=31536000");
	expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
	expect(headers["x-content-type-options"]).toBe("nosniff");
	expect(headers["x-frame-options"]).toBe("DENY");
	expect(headers["permissions-policy"]).toContain("camera=()");
	expect(headers["x-powered-by"]).toBeUndefined();
	await expect(page.getByRole("heading", { name: "UnoRAG" })).toBeVisible();
	await expect(
		page.getByText("Enterprise Knowledge Infrastructure", { exact: true }),
	).toBeVisible();
	await expectNoHorizontalOverflow(page);

	await page.goto("/app/libraries");
	await expect(page).toHaveURL(/\/login$/);
	await expect(page.getByRole("button", { name: "登录" })).toBeVisible();
});

test("authenticated knowledge and settings journeys fit the viewport", async ({
	page,
}) => {
	await signIn(page);

	await page.goto("/app/libraries");
	await expect(
		page.getByRole("heading", { name: "知识库" }).first(),
	).toBeVisible();
	await expect(page.getByText("资料空间", { exact: true })).toHaveCount(0);
	await expectNoHorizontalOverflow(page);

	await page.goto("/app/settings");
	await expect(page.getByRole("heading", { name: "工作区设置" })).toBeVisible();
	await expect(page.getByText("明文仅创建时显示一次")).toBeVisible();
	await expect(page.getByRole("button", { name: "创建密钥" })).toBeVisible();
	await expectNoHorizontalOverflow(page);

	const sessionBeforeLogout = await page.evaluate(async () => {
		const response = await fetch("/api/auth/session");
		return {
			status: response.status,
			cacheControl: response.headers.get("cache-control"),
		};
	});
	expect(sessionBeforeLogout.status).toBe(200);
	expect(sessionBeforeLogout.cacheControl).toContain("no-store");
	const logoutStatus = await page.evaluate(async () =>
		fetch("/api/auth/session", { method: "DELETE" }).then(
			(response) => response.status,
		),
	);
	expect(logoutStatus).toBe(200);
	const sessionAfterLogout = await page.evaluate(async () =>
		fetch("/api/auth/session").then((response) => response.status),
	);
	expect(sessionAfterLogout).toBe(401);
	await page.goto("/app/settings");
	await expect(page).toHaveURL(/\/login$/);
});

test("Judge diagnostics remain readable and omit absent legacy metadata", async ({
	page,
}, testInfo) => {
	await signIn(page);
	const id = "91000000-0000-4000-8000-000000000001";
	let mode: "provider" | "validation" | "legacy" = "provider";
	await page.route("**/api/workspace/operations", async (route) => {
		const response = await route.fetch();
		expect(response.ok()).toBe(true);
		const snapshot = await response.json();
		snapshot.recent_errors = [
			{
				id,
				source: "ask",
				status: "failed",
				stage: "judge",
				error_code: "judge_unavailable",
				occurred_at: new Date().toISOString(),
			},
		];
		await route.fulfill({ response, json: snapshot });
	});
	await page.route(
		`**/api/workspace/operations/events/ask/${id}`,
		async (route) => {
			await route.fulfill({
				json: {
					source: "ask",
					id,
					status: "failed",
					error_code: "judge_unavailable",
					guidance: errorGuidance("judge_unavailable"),
					request_id: id,
					otel_trace_id: null,
					workflow_id: null,
					library_id: null,
					document_id: null,
					document_version_id: null,
					query_type: "fact",
					retrieval_mode: "dense",
					started_at: new Date().toISOString(),
					ended_at: new Date().toISOString(),
					latency_ms: 4_120,
					message: null,
					stages: [
						{
							id: "judge-stage",
							sequence: 3,
							attempt: null,
							stage: "judge",
							outcome: "failed",
							error_code: "judge_unavailable",
							started_at: null,
							ended_at: null,
							duration_ms: 4_120,
							detail:
								mode === "legacy"
									? null
									: mode === "validation"
										? {
												judge_error_category: "evidence_validation",
												judge_failure_source: "evidence_validation",
												judge_failed_stage: "selected_ids",
												judge_validation_code: "selected_ids_unknown",
												judge_sufficiency_attempts: 1,
												judge_sufficiency_duration_ms: 4120.25,
											}
										: {
												judge_error_category: "provider_unavailable",
												judge_attempts: 2,
												judge_max_attempts: 2,
												judge_timeout_ms: 12_000,
												judge_budget_ms: 24_000,
												judge_duration_ms: 4_120.25,
												judge_status_code: 503,
												judge_retryable: true,
											},
						},
					],
				},
			});
		},
	);
	await page.goto("/app/operations");
	await page.getByRole("row").filter({ hasText: "judge_unavailable" }).click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByRole("heading", { name: "Judge 诊断 · 阶段 3" }),
	).toBeVisible();
	for (const value of [
		"provider_unavailable",
		"应用层尝试次数",
		"24000 ms",
		"4120.25 ms",
		"503",
	])
		await expect(dialog.getByText(value, { exact: true })).toBeVisible();
	await expectNoHorizontalOverflow(page);
	expect(
		await dialog
			.locator("dd")
			.evaluateAll((nodes) =>
				nodes.every((node) => node.scrollWidth <= node.clientWidth + 1),
			),
	).toBe(true);
	await page.screenshot({
		path: testInfo.outputPath("judge-diagnostics.png"),
		fullPage: true,
	});
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	mode = "validation";
	await page.getByRole("row").filter({ hasText: "judge_unavailable" }).click();
	await expect(dialog).toBeVisible();
	for (const value of [
		"selected_ids_unknown",
		"充分性已完成尝试",
		"4120.25 ms",
	])
		await expect(dialog.getByText(value, { exact: true })).toBeVisible();
	await expect(dialog.getByText("HTTP 状态", { exact: true })).toHaveCount(0);
	await expectNoHorizontalOverflow(page);
	expect(
		await dialog
			.locator("dd")
			.evaluateAll((nodes) =>
				nodes.every((node) => node.scrollWidth <= node.clientWidth + 1),
			),
	).toBe(true);
	await page.screenshot({
		path: testInfo.outputPath("judge-validation-diagnostics.png"),
		fullPage: true,
	});
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	mode = "legacy";
	await page.getByRole("row").filter({ hasText: "judge_unavailable" }).click();
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("heading", { name: /Judge 诊断/ })).toHaveCount(
		0,
	);
	await expect(dialog.getByText("应用层尝试次数", { exact: true })).toHaveCount(
		0,
	);
});
