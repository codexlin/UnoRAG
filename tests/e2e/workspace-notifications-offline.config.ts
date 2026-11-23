import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "workspace-notifications-offline.spec.ts",
	outputDir: "../../.unorag/test-results/workspace-notifications-offline",
	workers: 1,
	retries: 0,
	use: { locale: "zh-CN", trace: "retain-on-failure" },
	projects: [
		{ name: "desktop", use: devices["Desktop Chrome"] },
		{ name: "mobile", use: { ...devices["Pixel 7"], browserName: "chromium" } },
	],
});
