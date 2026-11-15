import { type Cookie, expect, type Page, test } from "@playwright/test";
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
	await page.waitForURL((url) => url.pathname === "/app/ask");
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
	if (process.env.UNORAG_E2E_TARGET_MODE === "development") {
		expect(headers["strict-transport-security"]).toBeUndefined();
		expect(headers["content-security-policy"]).toContain("'unsafe-eval'");
	} else {
		expect(headers["strict-transport-security"]).toContain("max-age=31536000");
		expect(headers["content-security-policy"]).not.toContain("'unsafe-eval'");
	}
	expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
	expect(headers["x-content-type-options"]).toBe("nosniff");
	expect(headers["x-frame-options"]).toBe("DENY");
	expect(headers["permissions-policy"]).toContain("camera=()");
	expect(headers["x-powered-by"]).toBeUndefined();
	await expect(page.getByRole("heading", { name: "UnoRAG" })).toBeVisible();
	await expect(
		page.getByText("开源 · 私有化部署 · Apache-2.0", { exact: true }),
	).toBeVisible();
	await expectNoHorizontalOverflow(page);

	await page.goto("/app/libraries");
	await expect(page).toHaveURL(/\/login$/);
	await expect(page.getByRole("button", { name: "登录" })).toBeVisible();
});

test("static delivery preserves shared warm-cache assets without routing", async ({
	page,
	request,
}, testInfo) => {
	test.slow();
	const targetMode = process.env.UNORAG_E2E_TARGET_MODE ?? "production";
	const probe = `static-delivery-${Date.now()}`;
	const navigations = [];
	// page.route would disable the HTTP cache this test needs to exercise.
	for (const phase of ["cold", "warm"]) {
		const response = await page.goto(`/login?probe=${probe}-${phase}`, {
			waitUntil: "load",
		});
		expect(response?.status()).toBe(200);
		const resources = await page.evaluate(async () => {
			await document.fonts.ready;
			return (
				performance.getEntriesByType("resource") as PerformanceResourceTiming[]
			)
				.filter((entry) => {
					const url = new URL(entry.name);
					return (
						url.origin === location.origin &&
						url.pathname.startsWith("/_next/static/")
					);
				})
				.map((entry) => ({
					path: new URL(entry.name).pathname,
					transferSize: entry.transferSize,
					encodedBodySize: entry.encodedBodySize,
					decodedBodySize: entry.decodedBodySize,
				}));
		});
		navigations.push({ phase, resources });
		await testInfo.attach(`static-delivery-${phase}`, {
			body: JSON.stringify({ targetMode, phase, resources }, null, 2),
			contentType: "application/json",
		});
		expect(resources.length).toBeGreaterThan(0);
	}
	const [cold, warm] = navigations;
	const coldPaths = new Set(
		cold.resources
			.filter((resource) => resource.decodedBodySize > 0)
			.map((resource) => resource.path),
	);
	const sharedByPath = warm.resources.filter((resource) =>
		coldPaths.has(resource.path),
	);
	const shared = sharedByPath.filter(
		(resource) => resource.decodedBodySize > 0,
	);
	const cached = shared.filter((resource) => resource.transferSize === 0);
	await testInfo.attach("static-delivery-shared-cache", {
		body: JSON.stringify(
			{
				targetMode,
				sharedPaths: sharedByPath.map((resource) => resource.path),
				decodedSharedPaths: shared.map((resource) => resource.path),
				cachedPaths: cached.map((resource) => resource.path),
			},
			null,
			2,
		),
		contentType: "application/json",
	});
	expect(sharedByPath.length).toBeGreaterThan(0);
	if (targetMode === "production") {
		expect(shared.length).toBeGreaterThan(0);
		expect(cached.length).toBeGreaterThan(0);
	}
	// Development 304s may expose zero body sizes despite reusing the stored CSS.
	const cssResources = targetMode === "development" ? sharedByPath : shared;
	const css = cssResources.find((resource) => resource.path.endsWith(".css"));
	if (!css)
		throw new Error("Expected a shared same-origin static CSS resource");
	const cssResponse = await request.get(css.path, {
		headers: { "Accept-Encoding": "gzip" },
	});
	const cssHeaders = cssResponse.headers();
	const cssMetadata = {
		targetMode,
		path: css.path,
		status: cssResponse.status(),
		cacheControl: cssHeaders["cache-control"] ?? "",
		contentEncoding: cssHeaders["content-encoding"],
		contentType: cssHeaders["content-type"],
		decodedBytes: (await cssResponse.body()).byteLength,
	};
	await testInfo.attach("static-delivery-css-response", {
		body: JSON.stringify(cssMetadata, null, 2),
		contentType: "application/json",
	});
	expect(cssMetadata.status).toBe(200);
	expect(cssMetadata.contentType).toContain("text/css");
	expect(cssMetadata.decodedBytes).toBeGreaterThan(0);
	expect(cssMetadata.contentEncoding).toBe("gzip");
	if (targetMode === "development") {
		expect(cssMetadata.cacheControl).not.toMatch(/\bimmutable\b/i);
		expect(cssMetadata.cacheControl).toMatch(/\b(?:no-cache|no-store)\b/i);
	} else {
		expect(cssMetadata.cacheControl).toMatch(/\bpublic\b/i);
		expect(cssMetadata.cacheControl).toMatch(/\bimmutable\b/i);
	}
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

	await page.goto("/app/settings#integrations");
	await expect(page.getByRole("heading", { name: "工作区设置" })).toBeVisible();
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

test.describe("Judge diagnostic presentation", () => {
	let cookies: Cookie[] = [];
	let liveSnapshot: Record<string, unknown>;

	test.beforeAll(async ({ request }) => {
		if (!email || !password)
			throw new Error("E2E administrator credentials required");
		const login = await request.post("/api/auth/session", {
			data: { email, password },
		});
		expect(login.status()).toBe(200);
		const response = await request.get("/api/workspace/operations");
		expect(
			response.status(),
			"Live operations snapshot must load before diagnostic overrides",
		).toBe(200);
		liveSnapshot = await response.json();
		cookies = (await request.storageState()).cookies;
	});

	test("Judge diagnostics remain readable and omit absent legacy metadata", async ({
		page,
		context,
	}, testInfo) => {
		await context.addCookies(cookies);
		const id = "91000000-0000-4000-8000-000000000001";
		let mode: "provider" | "validation" | "legacy" = "provider";
		// Keep real API setup outside the UI's bounded snapshot request.
		const snapshot = structuredClone(liveSnapshot);
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
		await page.route("**/api/workspace/operations", (route) =>
			route.fulfill({ json: snapshot }),
		);
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
		const errorButton = page
			.getByRole("region", { name: "最近错误", exact: true })
			.getByRole("button", { name: `查看请求错误 ${id}`, exact: true });
		await errorButton.click();
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
		await errorButton.click();
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
		await errorButton.click();
		await expect(dialog).toBeVisible();
		await expect(
			dialog.getByRole("heading", { name: /Judge 诊断/ }),
		).toHaveCount(0);
		await expect(
			dialog.getByText("应用层尝试次数", { exact: true }),
		).toHaveCount(0);
	});
});
