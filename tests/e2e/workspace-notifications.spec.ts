import { type Cookie, expect, type Page, test } from "@playwright/test";

import {
	DEFAULT_WORKSPACE_EMAIL_SETTINGS,
	type WorkspaceNotificationsView,
	workspaceEmailSettingsSchema,
} from "../../src/lib/workspace-notifications";

let cookies: Cookie[] = [];
const browserErrors = new WeakMap<Page, string[]>();

test.beforeAll(async ({ browser }) => {
	const email = process.env.UNORAG_E2E_ADMIN_EMAIL;
	const password = process.env.UNORAG_E2E_ADMIN_PASSWORD;
	if (!email || !password)
		throw new Error("E2E administrator credentials required");
	const context = await browser.newContext({
		baseURL: process.env.UNORAG_E2E_BASE_URL,
	});
	try {
		const page = await context.newPage();
		await page.goto("/login");
		await page.getByLabel("邮箱").fill(email);
		await page.getByLabel("密码").fill(password);
		await page.getByRole("button", { name: "登录", exact: true }).click();
		await page.waitForURL((url) => url.pathname.startsWith("/app"));
		cookies = await context.cookies();
	} finally {
		await context.close();
	}
});

test.beforeEach(async ({ page, context }) => {
	await context.addCookies(cookies);
	const errors: string[] = [];
	browserErrors.set(page, errors);
	page.on("pageerror", (error) => errors.push(error.message));
});

test.afterEach(async ({ page }) => {
	await page.unrouteAll({ behavior: "wait" });
	expect(browserErrors.get(page)).toEqual([]);
});

function initialView(): WorkspaceNotificationsView {
	return {
		settings: { ...DEFAULT_WORKSPACE_EMAIL_SETTINGS, recipients: [] },
		version: 0,
		updated_at: null,
		transport: { status: "configured", checked_at: new Date().toISOString() },
		deliveries: [],
	};
}

async function noOverflow(page: Page) {
	await expect
		.poll(() =>
			page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth + 1,
			),
		)
		.toBe(true);
}

test("notification form saves settings and distinguishes queued from accepted (mock notification API)", async ({
	page,
}, info) => {
	let view = initialView();
	let queuedReads = 0;
	const tests: unknown[] = [];
	await page.route("**/api/workspace/notifications**", async (route) => {
		const request = route.request();
		if (request.method() === "GET") {
			if (view.deliveries.length && ++queuedReads >= 2) {
				view.deliveries[0] = {
					...view.deliveries[0],
					status: "sent",
					delivered_at: new Date().toISOString(),
					provider_message_id: "11111111-1111-4111-8111-111111111111",
					attempt: 1,
				};
			}
			await route.fulfill({ json: view });
		} else if (request.method() === "PATCH") {
			const body = request.postDataJSON();
			expect(body.version).toBe(view.version);
			view = {
				...view,
				version: view.version + 1,
				updated_at: new Date().toISOString(),
				settings: workspaceEmailSettingsSchema.parse(body.settings),
			};
			await route.fulfill({ json: view });
		} else if (
			request.method() === "POST" &&
			new URL(request.url()).pathname.endsWith("/test")
		) {
			tests.push(request.postDataJSON());
			const stamp = new Date().toISOString();
			view.deliveries = [
				{
					id: "22222222-2222-4222-8222-222222222222",
					purpose: "test",
					recipient: view.settings.recipients[0],
					status: "pending",
					attempt: 0,
					max_attempts: 5,
					error_code: null,
					created_at: stamp,
					delivered_at: null,
					next_attempt_at: stamp,
					provider_message_id: null,
				},
			];
			await route.fulfill({ status: 202, json: { queued: 1 } });
		} else await route.fulfill({ status: 405 });
	});
	await page.goto("/app/settings");
	const panel = page.getByRole("region", { name: "邮件通知", exact: true });
	await expect(
		panel.getByText("邮件服务：已配置", { exact: true }),
	).toBeVisible();
	await expect(
		panel.getByRole("button", { name: "发送测试邮件" }),
	).toBeDisabled();
	await panel.getByRole("button", { name: "添加收件邮箱" }).click();
	await panel.getByLabel("收件邮箱 1", { exact: true }).fill("ops@example");
	await expect(
		panel.getByRole("button", { name: "保存通知设置" }),
	).toBeDisabled();
	await panel
		.getByLabel("收件邮箱 1", { exact: true })
		.fill("Ops@Example.test");
	await panel.getByRole("button", { name: "保存通知设置" }).click();
	await expect(
		panel.getByText("邮件通知设置已保存", { exact: true }),
	).toBeVisible();
	await expect(panel.getByLabel("收件邮箱 1", { exact: true })).toHaveValue(
		"ops@example.test",
	);
	await panel.getByRole("button", { name: "发送测试邮件" }).click();
	await expect(
		panel.getByText("测试邮件已入队", { exact: true }),
	).toBeVisible();
	await expect(panel.getByText("等待发送", { exact: true })).toBeVisible();
	await expect(panel.getByText("服务商已接受", { exact: true })).toBeVisible({
		timeout: 10_000,
	});
	expect(tests).toEqual([{ version: 1 }]);
	expect(view.settings.enabled).toBe(false);
	await noOverflow(page);
	await panel.screenshot({ path: info.outputPath("email-notifications.png") });
});

test("notification conflicts preserve drafts and failed refresh clears readiness (mock notification API)", async ({
	page,
}) => {
	let view = {
		...initialView(),
		version: 1,
		settings: {
			...DEFAULT_WORKSPACE_EMAIL_SETTINGS,
			recipients: ["ops@example.test"],
		},
	};
	let conflict = true;
	let failedRead = false;
	await page.route("**/api/workspace/notifications**", async (route) => {
		if (route.request().method() === "GET") {
			await route.fulfill(
				failedRead
					? { status: 503, json: { detail: "unavailable" } }
					: { json: view },
			);
		} else if (route.request().method() === "PATCH") {
			if (conflict) {
				conflict = false;
				view = {
					...view,
					version: 2,
					settings: { ...view.settings, recipients: ["other@example.test"] },
				};
				await route.fulfill({
					status: 409,
					json: { code: "version_conflict" },
				});
			} else {
				const body = route.request().postDataJSON();
				expect(body.version).toBe(2);
				view = {
					...view,
					version: 3,
					settings: workspaceEmailSettingsSchema.parse(body.settings),
				};
				await route.fulfill({ json: view });
			}
		} else await route.fulfill({ status: 405 });
	});
	await page.goto("/app/settings");
	const panel = page.getByRole("region", { name: "邮件通知", exact: true });
	const address = panel.getByLabel("收件邮箱 1", { exact: true });
	await expect(address).toHaveValue("ops@example.test");
	await address.fill("draft@example.test");
	await panel.getByRole("button", { name: "保存通知设置" }).click();
	await expect(
		panel.getByRole("alert").filter({ hasText: "当前草稿已保留" }),
	).toBeVisible();
	await expect(address).toHaveValue("draft@example.test");
	await panel.getByRole("button", { name: "刷新邮件通知" }).click();
	await panel.getByRole("button", { name: "确认保留草稿" }).click();
	await panel.getByRole("button", { name: "保存通知设置" }).click();
	await expect(
		panel.getByText("邮件通知设置已保存", { exact: true }),
	).toBeVisible();
	expect(view.settings.recipients).toEqual(["draft@example.test"]);
	failedRead = true;
	await panel.getByRole("button", { name: "刷新邮件通知" }).click();
	await expect(
		panel.getByText("邮件服务：状态未知", { exact: true }),
	).toBeVisible();
	await expect(
		panel.getByRole("button", { name: "发送测试邮件" }),
	).toBeDisabled();
	await expect(
		panel.getByText("邮件服务：已配置", { exact: true }),
	).toHaveCount(0);
	await expect(address).toHaveValue("draft@example.test");
	await noOverflow(page);
});
