import { expect, type Page, test } from "@playwright/test";

const browserErrors = new WeakMap<Page, string[]>();
const unexpectedMailRequests = new WeakMap<Page, string[]>();
const acceptedMessage =
	"如果该邮箱对应可用账户，你将收到 6 位验证码和一次性链接。请检查收件箱和垃圾邮件。";

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
	const mailLogin = page.getByRole("link", { name: "使用邮箱登录" });
	await expect(mailLogin).toHaveAttribute(
		"href",
		"/account-access?purpose=login",
	);
	await mailLogin.click();
	await expect(
		page.getByRole("heading", { name: "使用邮箱登录" }),
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
		for (const [index, email] of [
			"member@example.test",
			"unknown@example.test",
		].entries()) {
			if (index > 0) {
				await page.getByRole("button", { name: "更换邮箱" }).click();
			}
			await page.getByLabel("邮箱").fill(email);
			await page.getByRole("button", { name: "发送验证码与链接" }).click();
			await expect(page.getByRole("status")).toHaveText(acceptedMessage);
			await expect(
				page.getByLabel("6 位验证码", { exact: true }),
			).toBeVisible();
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
		const send = page.getByRole("button", { name: "发送验证码与链接" });
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
		const target = mustChangePassword ? "/change-password" : "/app/ask";
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

test("cross-device 6-digit OTP signs in on the requesting browser (mock mail API)", async ({
	page,
}) => {
	const consumes: unknown[] = [];
	await page.route("**/api/auth/email/request", (route) =>
		route.fulfill({ status: 202, json: {} }),
	);
	await page.route("**/api/auth/email/consume", async (route) => {
		consumes.push(route.request().postDataJSON());
		await route.fulfill({
			status: 200,
			json: { mustChangePassword: false, session_created: true },
		});
	});
	await page.route(
		(url) => url.pathname === "/app/ask",
		(route) =>
			route.fulfill({
				contentType: "text/html",
				body: "<h1>Mock authenticated destination</h1>",
			}),
	);

	await page.goto("/account-access?purpose=login");
	await page.getByLabel("邮箱", { exact: true }).fill("codexlin@gmail.com");
	await page.getByRole("button", { name: "发送验证码与链接" }).click();

	const otp = page.getByLabel("6 位验证码", { exact: true });
	await expect(otp).toBeVisible();
	// Reject incomplete code before calling consume.
	await otp.fill("123");
	await page.getByRole("button", { name: "验证并登录" }).click();
	await expect(page.getByRole("main").getByRole("alert")).toContainText(
		"6 位数字验证码",
	);
	expect(consumes).toEqual([]);

	await otp.fill("482917");
	await page.getByRole("button", { name: "验证并登录" }).click();
	await expect(page).toHaveURL(/\/app\/ask$/);
	expect(consumes).toEqual([
		{ purpose: "login", email: "codexlin@gmail.com", code: "482917" },
	]);
});

test("password login shows entering workspace state while navigating directly to /app/ask (mock session API)", async ({
	page,
}) => {
	type LoginSnapshot = {
		phase: "mutation" | "settled";
		buttonText: string;
		buttonDisabled: boolean;
		emailDisabled: boolean;
		passwordDisabled: boolean;
		hasSpinner: boolean;
	};
	const snapshots: LoginSnapshot[] = [];
	let markSettled = () => {};
	const settledObserved = new Promise<void>((resolve) => {
		markSettled = resolve;
	});
	let submitted = false;
	const appHopRequests: string[] = [];
	const rscRequestsAfterSubmit: string[] = [];
	const appAskRequests: string[] = [];
	const trackRequests = (request: { url: () => string }) => {
		if (!submitted) return;
		const url = new URL(request.url());
		if (url.pathname === "/app") appHopRequests.push(request.url());
		if (url.searchParams.has("_rsc"))
			rscRequestsAfterSubmit.push(request.url());
		if (url.pathname === "/app/ask") appAskRequests.push(request.url());
	};

	await page.exposeFunction("__recordLoginState", (snapshot: LoginSnapshot) => {
		snapshots.push(snapshot);
		if (snapshot.phase === "settled") markSettled();
	});
	await page.route("**/api/auth/session", (route) =>
		route.fulfill({ status: 200, json: { mustChangePassword: false } }),
	);
	await page.route(
		(url) => url.pathname === "/app/ask",
		async (route) => {
			await Promise.race([
				settledObserved,
				new Promise<void>((resolve) => setTimeout(resolve, 2000)),
			]);
			await route.fulfill({
				contentType: "text/html",
				body: "<h1>Mock ask workspace</h1>",
			});
		},
	);

	page.on("request", trackRequests);
	try {
		await page.goto("/login");
		await page.getByLabel("邮箱").fill("member@example.test");
		await page.getByLabel("密码", { exact: true }).fill("ValidPass7");
		await page.evaluate(() => {
			const record = (
				window as unknown as {
					__recordLoginState: (snapshot: LoginSnapshot) => void;
				}
			).__recordLoginState;
			const read = (phase: "mutation" | "settled"): LoginSnapshot => {
				const button = document.querySelector<HTMLButtonElement>(
					'button[type="submit"]',
				);
				const email = document.querySelector<HTMLInputElement>("#email");
				const password = document.querySelector<HTMLInputElement>("#password");
				return {
					phase,
					buttonText: button?.textContent?.trim() ?? "",
					buttonDisabled: button?.disabled ?? false,
					emailDisabled: email?.disabled ?? false,
					passwordDisabled: password?.disabled ?? false,
					hasSpinner: Boolean(button?.querySelector("svg.animate-spin")),
				};
			};
			let scheduled = false;
			const observer = new MutationObserver(() => {
				const snapshot = read("mutation");
				record(snapshot);
				if (!scheduled && snapshot.buttonText === "正在进入工作区...") {
					scheduled = true;
					window.setTimeout(() => record(read("settled")), 100);
				}
			});
			observer.observe(document.body, {
				subtree: true,
				childList: true,
				characterData: true,
				attributes: true,
			});
		});

		submitted = true;
		await page.getByRole("button", { name: "登录", exact: true }).click();
		await expect(page).toHaveURL(/\/app\/ask$/);

		const settled = snapshots.filter((item) => item.phase === "settled");
		expect(settled.length).toBeGreaterThanOrEqual(1);
		expect(settled.at(-1)).toEqual({
			phase: "settled",
			buttonText: "正在进入工作区...",
			buttonDisabled: true,
			emailDisabled: true,
			passwordDisabled: true,
			hasSpinner: true,
		});
		const enteringIndex = snapshots.findIndex(
			(item) => item.buttonText === "正在进入工作区...",
		);
		expect(enteringIndex).toBeGreaterThanOrEqual(0);
		expect(
			snapshots
				.slice(enteringIndex)
				.every(
					(item) =>
						item.buttonText === "正在进入工作区..." && item.buttonDisabled,
				),
		).toBe(true);
		expect(appHopRequests).toEqual([]);
		expect(rscRequestsAfterSubmit).toEqual([]);
		expect(appAskRequests).toHaveLength(1);
	} finally {
		page.off("request", trackRequests);
	}
});

test("email login shows entering workspace status while navigating directly to /app/ask (mock mail API)", async ({
	page,
}) => {
	type EmailLoginSnapshot = {
		phase: "mutation" | "settled";
		hasSubtitle: boolean;
		statusText: string;
		hasSpinner: boolean;
		submitButtons: number;
	};
	const snapshots: EmailLoginSnapshot[] = [];
	let markSettled = () => {};
	const settledObserved = new Promise<void>((resolve) => {
		markSettled = resolve;
	});
	let submitted = false;
	const appHopRequests: string[] = [];
	const rscRequestsAfterSubmit: string[] = [];
	const appAskRequests: string[] = [];
	const trackRequests = (request: { url: () => string }) => {
		if (!submitted) return;
		const url = new URL(request.url());
		if (url.pathname === "/app") appHopRequests.push(request.url());
		if (url.searchParams.has("_rsc"))
			rscRequestsAfterSubmit.push(request.url());
		if (url.pathname === "/app/ask") appAskRequests.push(request.url());
	};

	await page.exposeFunction(
		"__recordEmailLoginState",
		(snapshot: EmailLoginSnapshot) => {
			snapshots.push(snapshot);
			if (snapshot.phase === "settled") markSettled();
		},
	);
	await page.route("**/api/auth/email/consume", (route) =>
		route.fulfill({
			status: 200,
			json: { mustChangePassword: false, session_created: true },
		}),
	);
	await page.route(
		(url) => url.pathname === "/app/ask",
		async (route) => {
			await Promise.race([
				settledObserved,
				new Promise<void>((resolve) => setTimeout(resolve, 2000)),
			]);
			await route.fulfill({
				contentType: "text/html",
				body: "<h1>Mock ask workspace</h1>",
			});
		},
	);

	page.on("request", trackRequests);
	try {
		await page.goto("/account-access#token=direct-nav-token&purpose=login");
		const confirm = page.getByRole("button", { name: "确认登录", exact: true });
		await expect(confirm).toBeEnabled();
		await page.evaluate(() => {
			const record = (
				window as unknown as {
					__recordEmailLoginState: (snapshot: EmailLoginSnapshot) => void;
				}
			).__recordEmailLoginState;
			const read = (phase: "mutation" | "settled"): EmailLoginSnapshot => {
				const status = document.querySelector('[role="status"]');
				return {
					phase,
					hasSubtitle: (document.body.textContent ?? "").includes(
						"验证成功，正在进入工作区。",
					),
					statusText: status?.textContent?.trim() ?? "",
					hasSpinner: Boolean(status?.querySelector("svg.animate-spin")),
					submitButtons: document.querySelectorAll('button[type="submit"]')
						.length,
				};
			};
			let scheduled = false;
			const observer = new MutationObserver(() => {
				const snapshot = read("mutation");
				record(snapshot);
				if (!scheduled && snapshot.statusText === "正在进入工作区，请稍候…") {
					scheduled = true;
					window.setTimeout(() => record(read("settled")), 100);
				}
			});
			observer.observe(document.body, {
				subtree: true,
				childList: true,
				characterData: true,
				attributes: true,
			});
		});

		submitted = true;
		await confirm.click();
		await expect(page).toHaveURL(/\/app\/ask$/);

		const settled = snapshots.filter((item) => item.phase === "settled");
		expect(settled.length).toBeGreaterThanOrEqual(1);
		expect(settled.at(-1)).toEqual({
			phase: "settled",
			hasSubtitle: true,
			statusText: "正在进入工作区，请稍候…",
			hasSpinner: true,
			submitButtons: 0,
		});
		expect(appHopRequests).toEqual([]);
		expect(rscRequestsAfterSubmit).toEqual([]);
		expect(appAskRequests).toHaveLength(1);
	} finally {
		page.off("request", trackRequests);
	}
});
