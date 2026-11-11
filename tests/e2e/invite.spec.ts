import { expect, type Page, test } from "@playwright/test";

const token = "a".repeat(43);
const errors = new WeakMap<Page, string[]>();
const unexpected = new WeakMap<Page, string[]>();

// All preview and acceptance APIs are mocked. These tests never create accounts,
// consume real invites, issue real sessions, or send email.
test.beforeEach(async ({ page }) => {
	const pageErrors: string[] = [];
	const requests: string[] = [];
	errors.set(page, pageErrors);
	unexpected.set(page, requests);
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.route("**/api/auth/invite**", async (route) => {
		requests.push(`${route.request().method()} ${route.request().url()}`);
		await route.fulfill({ status: 500, json: {} });
	});
});

test.afterEach(async ({ page }) => {
	await page.unrouteAll({ behavior: "wait" });
	expect(errors.get(page)).toEqual([]);
	expect(unexpected.get(page)).toEqual([]);
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth + 1,
		),
	).toBe(true);
});

async function mockPreview(page: Page, existingAccount: boolean) {
	const requests: unknown[] = [];
	await page.route("**/api/auth/invite/preview", async (route) => {
		expect(route.request().method()).toBe("POST");
		expect(route.request().url()).not.toContain("token");
		expect(route.request().headers()["content-type"]).toBe("application/json");
		requests.push(route.request().postDataJSON());
		await route.fulfill({
			json: {
				email: "member@example.test",
				role: "editor",
				workspaceName: "Mock Workspace",
				status: "pending",
				expiresAt: "2099-01-01T00:00:00Z",
				existingAccount,
			},
		});
	});
	return requests;
}

async function expectCleared(page: Page) {
	await expect(page).toHaveURL(/\/invite$/);
	await expect
		.poll(() =>
			page.evaluate(() =>
				JSON.stringify([localStorage, sessionStorage, history.state]),
			),
		)
		.not.toContain(token);
}

for (const existingAccount of [false, true]) {
	test(`${existingAccount ? "existing account" : "new registration"} requires explicit confirmation (mock preview/accept APIs)`, async ({
		page,
	}, info) => {
		const previews = await mockPreview(page, existingAccount);
		const accepts: unknown[] = [];
		const requestedUrls: string[] = [];
		page.on("request", (request) => requestedUrls.push(request.url()));
		await page.route("**/api/auth/invite", async (route) => {
			expect(route.request().method()).toBe("POST");
			accepts.push(route.request().postDataJSON());
			await route.fulfill({ json: { session_created: false } });
		});
		await page.route(
			(url) => url.pathname === "/login",
			(route) =>
				route.fulfill({
					contentType: "text/html",
					body: "<h1>Mock login destination</h1>",
				}),
		);
		await page.goto(`/invite#token=${token}`);
		const password = page.getByLabel(existingAccount ? "原密码" : "设置密码", {
			exact: true,
		});
		const confirm = page.getByRole("button", {
			name: "加入工作区",
			exact: true,
		});
		await expect(password).toBeVisible();
		await expectCleared(page);
		expect(previews).toEqual([{ token }]);
		expect(accepts).toEqual([]);
		if (existingAccount) {
			await expect(page.getByLabel("显示名称")).toHaveCount(0);
			await expect(password).toHaveAttribute(
				"autocomplete",
				"current-password",
			);
			expect(await password.getAttribute("minlength")).toBeNull();
			expect(await password.getAttribute("maxlength")).toBeNull();
			await password.fill("old");
		} else {
			await page.getByLabel("显示名称").fill("New Member");
			await expect(password).toHaveAttribute("autocomplete", "new-password");
			await expect(password).toHaveAttribute("minlength", "7");
			await expect(password).toHaveAttribute("maxlength", "256");
			for (const invalid of ["Aa1234", "Aa".repeat(129)]) {
				await password.evaluate((input: HTMLInputElement, value) => {
					input.value = value;
				}, invalid);
				await page.locator("form").dispatchEvent("submit");
				await expect(page.getByRole("main").getByRole("alert")).toHaveText(
					"密码需要 7–256 个字符",
				);
			}
			for (const invalid of ["lowercase", "UPPERCASE"]) {
				await password.fill(invalid);
				await confirm.click();
				await expect(page.getByRole("main").getByRole("alert")).toHaveText(
					"密码必须同时包含大写和小写字母",
				);
			}
			expect(accepts).toEqual([]);
			await password.fill("ValidPassword");
		}
		await page.screenshot({
			path: info.outputPath(
				existingAccount ? "invite-existing-mock.png" : "invite-new-mock.png",
			),
		});
		await confirm.click();
		await expect(page).toHaveURL(/\/login$/);
		expect(accepts).toEqual([
			existingAccount
				? { token, password: "old" }
				: { token, password: "ValidPassword", display_name: "New Member" },
		]);
		expect(requestedUrls.some((url) => url.includes(token))).toBe(false);
	});
}

test("legacy query is read once and cleared; reload cannot consume it (mock APIs)", async ({
	page,
}) => {
	const previews = await mockPreview(page, true);
	await page.goto(`/invite?token=${token}`);
	await expect(page.getByLabel("原密码")).toBeVisible();
	await expectCleared(page);
	expect(previews).toEqual([{ token }]);
	await page.reload();
	await expect(page.getByRole("main").getByRole("alert")).toHaveText(
		"缺少邀请链接",
	);
	expect(previews).toEqual([{ token }]);
});

test("fragment takes precedence over legacy query and both are cleared (mock APIs)", async ({
	page,
}) => {
	const previews = await mockPreview(page, true);
	await page.goto(`/invite?token=${"b".repeat(43)}#token=${token}`);
	await expect(page.getByLabel("原密码")).toBeVisible();
	await expectCleared(page);
	expect(previews).toEqual([{ token }]);
});

test("preview network failure never accepts an invite (mock APIs)", async ({
	page,
}) => {
	await page.route("**/api/auth/invite/preview", (route) =>
		route.abort("failed"),
	);
	await page.goto(`/invite#token=${token}`);
	await expect(page.getByRole("main").getByRole("alert")).toHaveText(
		"网络连接失败，请重新打开邀请链接重试",
	);
	await expectCleared(page);
	await expect(page.getByRole("button", { name: "加入工作区" })).toHaveCount(0);
});

test("accept network failure and wrong password permit manual retry (mock APIs)", async ({
	page,
}) => {
	await mockPreview(page, true);
	const accepts: unknown[] = [];
	await page.route("**/api/auth/invite", async (route) => {
		accepts.push(route.request().postDataJSON());
		if (accepts.length === 1) await route.abort("failed");
		else
			await route.fulfill({
				status: 403,
				json: { detail: "invalid password" },
			});
	});
	await page.goto(`/invite#token=${token}`);
	await page.getByLabel("原密码").fill("old");
	const confirm = page.getByRole("button", { name: "加入工作区", exact: true });
	await confirm.click();
	await expect(page.getByRole("main").getByRole("alert")).toContainText(
		"网络连接失败",
	);
	await expect(confirm).toBeEnabled();
	expect(accepts).toHaveLength(1);
	await confirm.click();
	await expect(page.getByRole("main").getByRole("alert")).toHaveText(
		"原密码不正确，请重试",
	);
	await expect(confirm).toBeEnabled();
	expect(accepts).toHaveLength(2);
	await expectCleared(page);
});
