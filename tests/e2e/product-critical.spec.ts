import { expect, type Page, test } from "@playwright/test";

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
