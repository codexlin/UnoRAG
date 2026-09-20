import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.UNORAG_E2E_BASE_URL?.trim();
if (!baseURL) {
	throw new Error(
		"UNORAG_E2E_BASE_URL is required; browser tests run against an installed candidate",
	);
}

export default defineConfig({
	testDir: "./tests/e2e",
	fullyParallel: false,
	workers: 1,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? "github" : "list",
	use: {
		baseURL,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
	},
	projects: [
		{
			name: "desktop-chromium",
			use: { ...devices["Desktop Chrome"] },
		},
		{
			name: "mobile-chromium",
			use: { ...devices["Pixel 7"], browserName: "chromium" },
		},
	],
});
