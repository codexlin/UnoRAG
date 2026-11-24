import { expect, type Page, test } from "@playwright/test";

const errors = new WeakMap<Page, string[]>();
const unexpectedAuthRequests = new WeakMap<Page, string[]>();

// All browser auth APIs are intercepted; no credentials, mail or real mutations.
test.beforeEach(async ({ page }) => {
	const pageErrors: string[] = [];
	const unexpected: string[] = [];
	errors.set(page, pageErrors);
	unexpectedAuthRequests.set(page, unexpected);
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.route("**/api/auth/**", async (route) => {
		unexpected.push(`${route.request().method()} ${route.request().url()}`);
		await route.fulfill({ status: 500, json: {} });
	});
});

test.afterEach(async ({ page }) => {
	await page.unrouteAll({ behavior: "wait" });
	expect(errors.get(page)).toEqual([]);
	expect(unexpectedAuthRequests.get(page)).toEqual([]);
});

async function expectLayout(page: Page) {
	await expect
		.poll(() =>
			page.evaluate(() => {
				const header = document.querySelector("header");
				const main = document.querySelector("main");
				const controls = document.querySelectorAll(
					"header button, main input, main button, main a",
				);
				return {
					overflow: document.documentElement.scrollWidth > innerWidth + 1,
					overlap:
						!header ||
						!main ||
						header.getBoundingClientRect().bottom >
							main.getBoundingClientRect().top + 1,
					controls: Array.from(controls).every((control) => {
						const rect = control.getBoundingClientRect();
						return rect.height >= 44 && rect.width >= 44;
					}),
					readable: Array.from(
						document.querySelectorAll("main p, main label, main a"),
					).every(
						(node) => Number.parseFloat(getComputedStyle(node).fontSize) >= 12,
					),
					inputSize: Array.from(document.querySelectorAll("main input")).every(
						(node) => Number.parseFloat(getComputedStyle(node).fontSize) >= 16,
					),
				};
			}),
		)
		.toEqual({
			overflow: false,
			overlap: false,
			controls: true,
			readable: true,
			inputSize: true,
		});
}

for (const { path, title } of [
	{ path: "/login", title: "登录 UnoRAG" },
	{ path: "/account-access?purpose=login", title: "使用邮箱登录" },
	{ path: "/account-access?purpose=reset", title: "重置密码" },
	{ path: "/invite", title: "接受邀请" },
]) {
	test(`${path} keeps readable, non-overlapping light/dark layouts with reduced motion`, async ({
		page,
	}, info) => {
		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.goto(path);
		await expect(
			page.getByRole("heading", { name: title, exact: true }),
		).toBeVisible();
		await expect(page.getByRole("button", { name: "外观设置" })).toBeEnabled();
		if (path === "/login")
			await expect(page.getByLabel("密码", { exact: true })).toBeEnabled();
		for (const theme of ["light", "dark"]) {
			await page.evaluate((value) => {
				document.documentElement.classList.toggle("dark", value === "dark");
				document.documentElement.classList.toggle("light", value === "light");
			}, theme);
			for (const width of [320, 390, 768, 1440]) {
				await page.setViewportSize({ width, height: 900 });
				await expectLayout(page);
			}
			await page.screenshot({
				path: info.outputPath(`account-${theme}.png`),
				animations: "disabled",
			});
		}
	});
}

test("login reserves feedback space and associates credential errors without changing POST fields", async ({
	page,
}) => {
	const requests: unknown[] = [];
	await page.route("**/api/auth/session", async (route) => {
		expect(route.request().method()).toBe("POST");
		requests.push(route.request().postDataJSON());
		await route.fulfill({ status: 401, json: {} });
	});
	await page.goto("/login");
	const form = page.locator("main form");
	await expect(form).toHaveAttribute("method", "post");
	const email = page.getByLabel("邮箱", { exact: true });
	const password = page.getByLabel("密码", { exact: true });
	await expect(email).toBeEnabled();
	await email.fill("layout@example.test");
	await password.fill("SyntheticPassword7");
	const submit = page.getByRole("button", { name: "登录", exact: true });
	const before = await submit.boundingBox();
	await submit.click();
	await expect(page.getByRole("main").getByRole("alert")).toHaveText(
		"邮箱或密码不正确",
	);
	await expect(password).toHaveAttribute("aria-invalid", "true");
	await expect(password).toHaveAccessibleDescription("邮箱或密码不正确");
	await expect(submit).toBeEnabled();
	const after = await submit.boundingBox();
	expect(before).not.toBeNull();
	expect(after).not.toBeNull();
	expect(Math.abs((before?.y ?? 0) - (after?.y ?? 0))).toBeLessThanOrEqual(1);
	expect(requests).toEqual([
		{ email: "layout@example.test", password: "SyntheticPassword7" },
	]);
	await email.focus();
	await page.keyboard.press("Tab");
	await expect(password).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(submit).toBeFocused();
	await expectLayout(page);
});

test("email request keeps generic acceptance and actionable service errors (mock API)", async ({
	page,
}) => {
	const requests: unknown[] = [];
	await page.route("**/api/auth/email/request", async (route) => {
		expect(route.request().method()).toBe("POST");
		requests.push(route.request().postDataJSON());
		await route.fulfill({
			status: requests.length === 1 ? 503 : 202,
			json: {},
		});
	});
	await page.goto("/account-access?purpose=login");
	const email = page.getByLabel("邮箱", { exact: true });
	await expect(email).toBeEnabled();
	const submit = page.getByRole("button", { name: "发送验证码与链接" });
	// Verify there is no excessive dead gap between the email input and submit button.
	const emailBox = await email.boundingBox();
	const submitBox = await submit.boundingBox();
	expect(emailBox).not.toBeNull();
	expect(submitBox).not.toBeNull();
	expect(
		(submitBox?.y ?? 0) - ((emailBox?.y ?? 0) + (emailBox?.height ?? 0)),
	).toBeLessThanOrEqual(32);

	await email.fill("layout@example.test");
	await submit.click();
	await expect(email).toHaveAccessibleDescription(
		"邮件服务暂时不可用，请稍后重试或使用密码登录。",
	);
	await expect(submit).toBeEnabled();
	await submit.click();
	await expect(page.getByRole("status")).toHaveText(
		"如果该邮箱对应可用账户，你将收到 6 位验证码和一次性链接。请检查收件箱和垃圾邮件。",
	);
	// Transitions cleanly into the 6-digit OTP verification step without overflow at 320px.
	await expect(page.getByLabel("6 位验证码", { exact: true })).toBeVisible();
	await page.setViewportSize({ width: 320, height: 900 });
	await expectLayout(page);
	const otpSlotsBounds = await page.evaluate(() => {
		const form = document.querySelector("main form")?.getBoundingClientRect();
		const slots = Array.from(
			document.querySelectorAll('[data-slot="input-otp-slot"]'),
		).map((el) => el.getBoundingClientRect());
		if (!form || slots.length !== 6) return { ok: false };
		const minLeft = Math.min(...slots.map((s) => s.left));
		const maxRight = Math.max(...slots.map((s) => s.right));
		return {
			ok: minLeft >= form.left - 1 && maxRight <= form.right + 1,
		};
	});
	expect(otpSlotsBounds).toEqual({ ok: true });
	expect(requests).toEqual(
		Array(2).fill({ email: "layout@example.test", purpose: "login" }),
	);
	await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
});

test("reset links keep tokens in memory and focus the invalid field before mocked one-time consumption", async ({
	page,
}) => {
	const token = "layout-reset-token";
	const requests: unknown[] = [];
	await page.route("**/api/auth/email/consume", async (route) => {
		expect(route.request().method()).toBe("POST");
		requests.push(route.request().postDataJSON());
		await route.fulfill({ json: { session_created: false } });
	});
	await page.goto(`/account-access#token=${token}&purpose=reset`);
	const password = page.getByLabel("新密码", { exact: true });
	const confirmation = page.getByLabel("确认新密码", { exact: true });
	await expect(password).toBeEnabled();
	await expect(page).toHaveURL(/\/account-access$/);
	expect(
		await page.evaluate(() =>
			JSON.stringify([localStorage, sessionStorage, history.state]),
		),
	).not.toContain(token);
	await expect(page.locator("main form")).toHaveAttribute("method", "post");
	await password.fill("lowercase");
	await confirmation.fill("lowercase");
	const submit = page.getByRole("button", { name: "重置密码", exact: true });
	await submit.click();
	await expect(password).toBeFocused();
	await expect(password).toHaveAttribute("aria-invalid", "true");
	await expect(password).toHaveAccessibleDescription(
		/新密码必须同时包含大写和小写字母/,
	);
	expect(requests).toEqual([]);
	await password.fill("SyntheticPassword7");
	await confirmation.fill("OtherPassword7");
	await submit.click();
	await expect(confirmation).toBeFocused();
	await expect(confirmation).toHaveAccessibleDescription(
		"两次输入的新密码不一致",
	);
	await confirmation.fill("SyntheticPassword7");
	await submit.click();
	await expect(page.getByRole("status")).toHaveText(
		"密码已重置，请使用新密码登录。",
	);
	await expect(submit).toHaveCount(0);
	expect(requests).toEqual([
		{ token, purpose: "reset", password: "SyntheticPassword7" },
	]);
	await expectLayout(page);
});

for (const existingAccount of [false, true]) {
	test(`invite ${existingAccount ? "existing" : "new"} account keeps long metadata readable and never accepts automatically`, async ({
		page,
	}) => {
		const token = "layout-invite-token";
		const requests: unknown[] = [];
		await page.route("**/api/auth/invite/preview", async (route) => {
			expect(route.request().method()).toBe("POST");
			expect(route.request().postDataJSON()).toEqual({ token });
			await route.fulfill({
				json: {
					email: `${"long-account-".repeat(4)}@example.test`,
					role: "editor",
					workspaceName: "VeryLongUnbrokenWorkspaceName".repeat(5),
					status: "pending",
					expiresAt: "2099-01-01T00:00:00Z",
					existingAccount,
				},
			});
		});
		await page.route("**/api/auth/invite", async (route) => {
			expect(route.request().method()).toBe("POST");
			requests.push(route.request().postDataJSON());
			await route.fulfill({
				status: 403,
				json: { detail: "invalid password" },
			});
		});
		await page.goto(`/invite#token=${token}`);
		await page.setViewportSize({ width: 320, height: 900 });
		const password = page.getByLabel(existingAccount ? "原密码" : "设置密码", {
			exact: true,
		});
		await expect(password).toBeEnabled();
		await expect(page.locator("main form")).toHaveAttribute("method", "post");
		await expect(page).toHaveURL(/\/invite$/);
		expect(requests).toEqual([]);
		await expectLayout(page);
		if (existingAccount)
			await expect(page.getByLabel("显示名称")).toHaveCount(0);
		else await page.getByLabel("显示名称").fill("Layout Member");
		await password.fill("SyntheticPassword7");
		await page.getByRole("button", { name: "加入工作区" }).click();
		await expect(password).toHaveAttribute("aria-invalid", "true");
		await expect(password).toHaveAccessibleDescription(/原密码不正确，请重试/);
		expect(requests).toEqual([
			existingAccount
				? { token, password: "SyntheticPassword7" }
				: {
						token,
						password: "SyntheticPassword7",
						display_name: "Layout Member",
					},
		]);
		await expect(
			page.getByRole("button", { name: "加入工作区" }),
		).toBeEnabled();
	});
}

test("login mounts credential fields after hydration so password-manager icons do not trigger recovery", async ({
	page,
}) => {
	const diagnostics: string[] = [];
	page.on("pageerror", (error) => diagnostics.push(error.message));
	page.on("console", (message) => {
		if (
			message.type() === "error" &&
			/Hydration failed|Encountered a script tag/.test(message.text())
		)
			diagnostics.push(message.text());
	});
	await page.addInitScript(() => {
		const state = { injections: 0, injectedBeforeReady: false };
		(
			window as Window & { passwordManagerProbe?: typeof state }
		).passwordManagerProbe = state;
		const inject = () => {
			const input = document.querySelector<HTMLInputElement>(
				'input[autocomplete="username"]',
			);
			if (!input || input.hasAttribute("data-protonpass-base-css")) return;
			state.injectedBeforeReady =
				document.querySelector<HTMLButtonElement>('form button[type="submit"]')
					?.disabled === true;
			input.style.paddingRight = "44px";
			input.setAttribute(
				"data-protonpass-base-css",
				JSON.stringify({ "padding-right": "" }),
			);
			const control = document.createElement("protonpass-control-test");
			control.setAttribute("data-protonpass-role", "icon");
			input.after(control);
			state.injections += 1;
		};
		new MutationObserver(inject).observe(document, {
			childList: true,
			subtree: true,
		});
		inject();
	});
	await page.goto("/login");
	await expect(
		page.getByRole("button", { name: "登录", exact: true }),
	).toBeEnabled();
	await expect(page.locator("protonpass-control-test")).toHaveCount(1);
	await page
		.getByLabel("邮箱", { exact: true })
		.fill("password-manager@example.test");
	await page.getByLabel("密码", { exact: true }).fill("NotARealCredential");
	expect(
		await page.evaluate(
			() =>
				(
					window as Window & {
						passwordManagerProbe?: {
							injections: number;
							injectedBeforeReady: boolean;
						};
					}
				).passwordManagerProbe,
		),
	).toEqual({ injections: 1, injectedBeforeReady: false });
	expect(diagnostics).toEqual([]);
});

test("login has no credential submission fallback when scripts are unavailable", async ({
	browser,
	baseURL,
}) => {
	const context = await browser.newContext({
		baseURL,
		javaScriptEnabled: false,
	});
	try {
		const page = await context.newPage();
		const navigations: string[] = [];
		page.on("request", (request) => {
			if (request.isNavigationRequest()) navigations.push(request.url());
		});
		await page.goto("/login");
		await expect(
			page.getByText("登录需要启用 JavaScript。", { exact: true }),
		).toBeVisible();
		await expect(page.locator("form")).toHaveCount(0);
		await expect(page.locator('input[type="password"]')).toHaveCount(0);
		await page.locator("body").press("Enter");
		expect(navigations.every((url) => !new URL(url).search)).toBe(true);
		await expect(page).toHaveURL(/\/login$/);
	} finally {
		await context.close();
	}
});

test("change-password retains the server-side anonymous access guard without altering credentials", async ({
	page,
}) => {
	await page.goto("/change-password");
	await expect(page).toHaveURL(/\/login$/);
	await expect(
		page.getByRole("heading", { name: "登录 UnoRAG" }),
	).toBeVisible();
});
