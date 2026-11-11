import { expect, type Page, test } from "@playwright/test";

const browserErrors = new WeakMap<Page, string[]>();
const unexpectedMailRequests = new WeakMap<Page, string[]>();
const acceptedMessage =
	"如果该邮箱对应可用账户，你将收到一封邮件。请检查收件箱和垃圾邮件。";

// Every mail endpoint is mocked: this suite never sends real mail or needs credentials.
test.beforeEach(async ({ page }) => {
	const errors: string[] = [];
	const unexpected: string[] = [];
	browserErrors.set(page, errors);
	unexpectedMailRequests.set(page, unexpected);
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/api/auth/email/**", async (route) => {
		unexpected.push(`${route.request().method()} ${route.request().url()}`);
		await route.fulfill({ status: 500, json: {} });
	});
});

test.afterEach(async ({ page }) => {
	await expect
		.poll(() =>
			page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth + 1,
			),
		)
		.toBe(true);
	await page.unrouteAll({ behavior: "wait" });
	expect(browserErrors.get(page)).toEqual([]);
	expect(unexpectedMailRequests.get(page)).toEqual([]);
});

test("password login remains the default and links select each mail purpose", async ({
	page,
}) => {
	await page.route("**/api/auth/session", (route) =>
		route.fulfill({ status: 401, json: {} }),
	);
	await page.goto("/login");
	await expect(page.getByLabel("密码", { exact: true })).toBeVisible();
	await page.getByLabel("邮箱").fill("member@example.test");
	await page.getByLabel("密码", { exact: true }).fill("WrongPassword");
	await page.getByRole("button", { name: "登录", exact: true }).click();
	await expect(page.getByRole("main").getByRole("alert")).toHaveText(
		"邮箱或密码不正确",
	);
	await expect(
		page.getByRole("button", { name: "登录", exact: true }),
	).toBeEnabled();
	const mailLogin = page.getByRole("link", { name: "使用邮箱链接登录" });
	await expect(mailLogin).toHaveAttribute(
		"href",
		"/account-access?purpose=login",
	);
	await mailLogin.click();
	await expect(
		page.getByRole("heading", { name: "使用邮箱链接登录" }),
	).toBeVisible();
	await page.getByRole("link", { name: "返回密码登录" }).click();
	const reset = page.getByRole("link", { name: "忘记密码" });
	await expect(reset).toHaveAttribute("href", "/account-access?purpose=reset");
	await reset.click();
	await expect(page.getByRole("heading", { name: "重置密码" })).toBeVisible();
});

for (const purpose of ["login", "reset"] as const) {
	test(`${purpose} requests show the same generic 202 notice (mock mail API)`, async ({
		page,
	}, info) => {
		const requests: unknown[] = [];
		await page.route("**/api/auth/email/request", async (route) => {
			expect(route.request().method()).toBe("POST");
			expect(route.request().headers()["content-type"]).toBe(
				"application/json",
			);
			requests.push(route.request().postDataJSON());
			await route.fulfill({
				status: 202,
				json: { detail: "private server detail" },
			});
		});
		await page.goto(`/account-access?purpose=${purpose}`);
		for (const email of ["member@example.test", "unknown@example.test"]) {
			await page.getByLabel("邮箱").fill(email);
			await page.getByRole("button", { name: "发送邮件链接" }).click();
			await expect(page.getByRole("status")).toHaveText(acceptedMessage);
		}
		expect(requests).toEqual([
			{ email: "member@example.test", purpose },
			{ email: "unknown@example.test", purpose },
		]);
		await expect(page.getByText("private server detail")).toHaveCount(0);
		await page.screenshot({
			path: info.outputPath(`email-request-${purpose}.png`),
		});
	});
}

for (const failure of [503, 429, "network"] as const) {
	test(`request recovers after ${failure} (mock mail API)`, async ({
		page,
	}) => {
		let fail = true;
		await page.route("**/api/auth/email/request", async (route) => {
			if (fail && failure === "network") await route.abort("failed");
			else
				await route.fulfill({ status: fail ? Number(failure) : 202, json: {} });
		});
		await page.goto("/account-access?purpose=login");
		await page.getByLabel("邮箱").fill("member@example.test");
		const send = page.getByRole("button", { name: "发送邮件链接" });
		await send.click();
		await expect(page.getByRole("main").getByRole("alert")).toContainText(
			failure === 503
				? "邮件服务暂时不可用"
				: failure === 429
					? "请求过于频繁"
					: "网络连接异常",
		);
		await expect(send).toBeEnabled();
		fail = false;
		await send.click();
		await expect(page.getByRole("status")).toHaveText(acceptedMessage);
		await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
	});
}

for (const mustChangePassword of [false, true]) {
	test(`login consumes only on confirmation and redirects (mustChangePassword=${mustChangePassword}; mock mail API)`, async ({
		page,
	}) => {
		const consumes: unknown[] = [];
		const token = "mail-only-token+/%=";
		const target = mustChangePassword ? "/change-password" : "/app";
		await page.route(
			(url) => url.pathname === target,
			(route) =>
				route.fulfill({
					contentType: "text/html",
					body: "<h1>Mock authenticated destination</h1>",
				}),
		);
		await page.route("**/api/auth/email/consume", async (route) => {
			expect(route.request().method()).toBe("POST");
			consumes.push(route.request().postDataJSON());
			await route.fulfill({
				json: { mustChangePassword, session_created: true },
			});
		});
		await page.goto(
			`/account-access?purpose=reset#token=${encodeURIComponent(token)}&purpose=login`,
		);
		const confirm = page.getByRole("button", { name: "确认登录", exact: true });
		await expect(confirm).toBeEnabled();
		await expect(page).toHaveURL(/\/account-access\?purpose=reset$/);
		await expect(page.getByLabel("新密码", { exact: true })).toHaveCount(0);
		expect(consumes).toEqual([]);
		expect(
			await page.evaluate(() =>
				JSON.stringify([localStorage, sessionStorage, history.state]),
			),
		).not.toContain(token);
		await confirm.click();
		await expect(page).toHaveURL(new RegExp(`${target}$`));
		expect(consumes).toEqual([{ token, purpose: "login" }]);
	});
}

test("cleared hash is not persisted or consumed by reload (mock mail API)", async ({
	page,
}) => {
	await page.goto("/account-access#token=reload-token&purpose=login");
	await expect(page.getByRole("button", { name: "确认登录" })).toBeEnabled();
	await expect(page).toHaveURL(/\/account-access$/);
	await page.reload();
	await expect(page.getByLabel("邮箱")).toBeEnabled();
	await expect(page.getByRole("button", { name: "确认登录" })).toHaveCount(0);
});

test("reset validates passwords before POST and returns to password login without a session (mock mail API)", async ({
	page,
}, info) => {
	const consumes: unknown[] = [];
	await page.route("**/api/auth/email/consume", async (route) => {
		expect(route.request().method()).toBe("POST");
		consumes.push(route.request().postDataJSON());
		await route.fulfill({ json: { session_created: false } });
	});
	await page.goto(
		"/account-access?purpose=login#token=reset-token&purpose=reset",
	);
	const password = page.getByLabel("新密码", { exact: true });
	const confirmation = page.getByLabel("确认新密码", { exact: true });
	const reset = page.getByRole("button", { name: "重置密码", exact: true });
	await expect(password).toBeVisible();
	await expect(page).toHaveURL(/\/account-access\?purpose=login$/);
	expect(consumes).toEqual([]);
	await expect(password).toHaveAttribute("minlength", "7");
	await expect(password).toHaveAttribute("maxlength", "256");
	for (const invalid of ["Aa1234", `Aa${"x".repeat(255)}`]) {
		await password.evaluate((input: HTMLInputElement, value) => {
			input.value = value;
		}, invalid);
		await confirmation.evaluate((input: HTMLInputElement, value) => {
			input.value = value;
		}, invalid);
		// Exercise the JS length guard as well as the browser's input constraints.
		await page.locator("form").dispatchEvent("submit");
		await expect(page.getByRole("main").getByRole("alert")).toHaveText(
			"新密码需要 7–256 个字符",
		);
	}
	for (const invalid of ["lowercase", "UPPERCASE"]) {
		await password.fill(invalid);
		await confirmation.fill(invalid);
		await reset.click();
		await expect(page.getByRole("main").getByRole("alert")).toHaveText(
			"新密码必须同时包含大写和小写字母",
		);
	}
	await password.fill("ValidPass7");
	await confirmation.fill("OtherPass7");
	await reset.click();
	await expect(page.getByRole("main").getByRole("alert")).toHaveText(
		"两次输入的新密码不一致",
	);
	expect(consumes).toEqual([]);
	await page.screenshot({
		path: info.outputPath("email-reset-validation.png"),
	});
	await confirmation.fill("ValidPass7");
	await reset.click();
	await expect(page.getByRole("status")).toHaveText(
		"密码已重置，请使用新密码登录。",
	);
	await expect(page).toHaveURL(/\/account-access\?purpose=login$/);
	await expect(reset).toHaveCount(0);
	expect(consumes).toEqual([
		{ token: "reset-token", purpose: "reset", password: "ValidPass7" },
	]);
	await page.getByRole("link", { name: "返回密码登录" }).click();
	await expect(page).toHaveURL(/\/login$/);
});

for (const failure of [503, 429, 410, "network", "json", "session"] as const) {
	test(`consume handles ${failure} safely (mock mail API)`, async ({
		page,
	}) => {
		let calls = 0;
		await page.route("**/api/auth/email/consume", async (route) => {
			calls += 1;
			expect(route.request().method()).toBe("POST");
			if (failure === "network") await route.abort("failed");
			else if (failure === "json")
				await route.fulfill({ contentType: "application/json", body: "{" });
			else
				await route.fulfill({
					status: failure === "session" ? 200 : failure,
					json: { session_created: false, detail: "private server detail" },
				});
		});
		await page.goto("/account-access#token=failed-token&purpose=login");
		const confirm = page.getByRole("button", { name: "确认登录" });
		await expect(confirm).toBeEnabled();
		expect(calls).toBe(0);
		await confirm.click();
		await expect(page.getByRole("main").getByRole("alert")).toContainText(
			failure === 429
				? "请求过于频繁"
				: failure === "network" || failure === "json"
					? "网络连接异常"
					: "重新申请",
		);
		await expect(page.getByText("private server detail")).toHaveCount(0);
		await expect(page).toHaveURL(/\/account-access$/);
		expect(calls).toBe(1);
		if (failure === 503 || failure === 410 || failure === "session")
			await expect(page.getByLabel("邮箱")).toBeEnabled();
		else await expect(confirm).toBeEnabled();
	});
}

test("malformed hash is cleared and query-string tokens are never consumed (mock mail API)", async ({
	page,
}) => {
	await page.goto(
		"/account-access#token=invalid-purpose-token&purpose=unknown",
	);
	await expect(page.getByRole("main").getByRole("alert")).toHaveText(
		"邮件链接无效，请重新申请。",
	);
	await expect(page).toHaveURL(/\/account-access$/);
	await expect(page.getByLabel("邮箱")).toBeEnabled();
	await page.goto("/account-access?purpose=reset&token=query-token");
	await expect(page.getByLabel("邮箱")).toBeEnabled();
	await expect(page.getByRole("button", { name: "确认登录" })).toHaveCount(0);
	await expect(page.getByLabel("新密码", { exact: true })).toHaveCount(0);
});
