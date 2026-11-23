import { expect, test } from "@playwright/test";

for (const { locale, language, heading } of [
	{ locale: "zh-CN", language: "zh-CN", heading: "登录 UnoRAG" },
	{ locale: "en-GB", language: "en", heading: "Sign in to UnoRAG" },
	{ locale: "ja-JP", language: "en", heading: "Sign in to UnoRAG" },
]) {
	test.describe(`system language: ${locale}`, () => {
		test.use({ locale, javaScriptEnabled: false });

		test("renders first-visit language without JavaScript", async ({
			page,
		}) => {
			await page.goto("/login");
			await expect(page.locator("html")).toHaveAttribute("lang", language);
			await expect(page.getByRole("heading", { name: heading })).toBeVisible();
		});
	});
}

test("manual selection persists across routes and can switch back", async ({
	page,
}) => {
	await page.goto("/login");
	await page.route("**/api/auth/session", (route) =>
		route.fulfill({ status: 401, json: { detail: "invalid credentials" } }),
	);
	await page.getByLabel("邮箱", { exact: true }).fill("reader@example.test");
	await page.getByLabel("密码", { exact: true }).fill("ExamplePassword");
	await page.getByRole("button", { name: "登录", exact: true }).click();
	await expect(page.locator("#login-error")).toHaveText("邮箱或密码不正确");
	await page.getByRole("button", { name: "界面语言" }).click();
	await expect(
		page.getByRole("menuitemradio", { name: "简体中文" }),
	).toBeChecked();
	await page.getByRole("menuitemradio", { name: "English" }).click();
	await expect(page.locator("html")).toHaveAttribute("lang", "en");
	await expect(page.getByLabel("Email", { exact: true })).toHaveValue(
		"reader@example.test",
	);
	await expect(page.locator("#login-error")).toHaveText(
		"Incorrect email or password",
	);
	await expect(page.getByLabel("Email", { exact: true })).toHaveAttribute(
		"aria-invalid",
		"true",
	);
	await page.reload();
	await expect(
		page.getByRole("heading", { name: "Sign in to UnoRAG" }),
	).toBeVisible();
	await page.getByRole("link", { name: "Forgot password" }).click();
	await expect(
		page.getByRole("heading", { name: "Reset password" }),
	).toBeVisible();
	await page.getByRole("button", { name: "Interface language" }).click();
	await expect(
		page.getByRole("menuitemradio", { name: "English" }),
	).toBeChecked();
	await page.getByRole("menuitemradio", { name: "简体中文" }).click();
	await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
	await expect(page.getByRole("heading", { name: "重置密码" })).toBeVisible();
});
