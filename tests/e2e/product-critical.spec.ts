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
	await page.goto("/");
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
	await expectNoHorizontalOverflow(page);
});
