import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
	DEFAULT_ASK_ALERT_THRESHOLDS,
	DEFAULT_WORKSPACE_EMAIL_SETTINGS,
	type WorkspaceNotificationsView,
} from "../../src/lib/workspace-notifications";

let server: Server;
let origin: string;

test.beforeAll(async () => {
	// Reuse tsx's compiler to mount the real component without a running app or login.
	const require = createRequire(__filename);
	const { build } = require(
		require.resolve("esbuild", {
			paths: [dirname(require.resolve("tsx"))],
		}),
	);
	const bundle = await build({
		stdin: {
			contents: `
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { SessionProvider } from "./src/components/app/session-provider";
import { WorkspaceNotificationsPanel } from "./src/components/app/workspace-notifications-panel";
import { LanguageProvider } from "./src/lib/i18n/provider";
const identity = {
  tenantId: "offline-org", workspaceId: "offline-workspace", workspaceName: "Offline",
  principalId: "offline-admin", groupIds: [], organizationRole: "member", role: "admin",
  email: "personal@example.test", displayName: "Admin", provider: "local", mustChangePassword: false,
};
const router = { replace() {}, refresh() {} };
createRoot(document.getElementById("root")).render(
  <AppRouterContext.Provider value={router}>
    <LanguageProvider language={{locale: "zh-CN"}}>
      <SessionProvider identity={identity}>
        <QueryClientProvider client={new QueryClient()}>
          <WorkspaceNotificationsPanel />
        </QueryClientProvider>
      </SessionProvider>
    </LanguageProvider>
  </AppRouterContext.Provider>
);
`,
			resolveDir: resolve(__dirname, "../.."),
			loader: "tsx",
		},
		bundle: true,
		write: false,
		format: "esm",
		platform: "browser",
		jsx: "automatic",
		define: { "process.env": JSON.stringify({ NODE_ENV: "development" }) },
	});
	server = createServer((request, response) => {
		if (request.url === "/fixture.js") {
			response.setHeader("content-type", "application/javascript");
			response.end(bundle.outputFiles[0].contents);
		} else {
			response.setHeader("content-type", "text/html; charset=utf-8");
			response.end(
				'<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/fixture.js"></script>',
			);
		}
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("missing local fixture address");
	origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
	if (!server) return;
	await new Promise<void>((done, reject) =>
		server.close((error) => (error ? reject(error) : done())),
	);
});

for (const edit of [
	"threshold",
	"severity",
	"recipient",
	"reset",
	"combined",
]) {
	test(`conflict retention writes only intended ${edit} edits`, async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		let view: WorkspaceNotificationsView = {
			settings: {
				...DEFAULT_WORKSPACE_EMAIL_SETTINGS,
				recipients: ["old@example.test"],
			},
			version: 1,
			alert_thresholds: edit === "reset" ? { ask_min_samples: 12 } : {},
			alert_defaults: DEFAULT_ASK_ALERT_THRESHOLDS,
			alert_policy_version: 0,
			updated_at: null,
			transport: { status: "configured", checked_at: null },
			deliveries: [],
		};
		const patches: Record<string, unknown>[] = [];
		await page.route("**/*", async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			if (url.origin !== origin) return route.abort();
			if (url.pathname !== "/api/workspace/notifications")
				return route.continue();
			if (request.method() === "PATCH") {
				const body = request.postDataJSON();
				patches.push(body);
				if (patches.length === 1) {
					view = {
						...view,
						version: 2,
						alert_thresholds: {
							...view.alert_thresholds,
							ask_failure_rate_warning: 0.2,
						},
						alert_policy_version: 1,
						settings: {
							...view.settings,
							recipients: ["new@example.test"],
							notify_recovery: false,
						},
					};
					return route.fulfill({
						status: 409,
						json: { code: "version_conflict" },
					});
				}
				view = {
					...view,
					...(body.settings
						? { settings: body.settings, version: view.version + 1 }
						: {}),
					...(body.alert_thresholds
						? {
								alert_thresholds: body.alert_thresholds,
								alert_policy_version: view.alert_policy_version + 1,
							}
						: {}),
				};
			}
			return route.fulfill({ json: view });
		});
		await page.goto(origin);
		const address = page.getByLabel("收件邮箱 1", { exact: true });
		await expect(address).toHaveValue("old@example.test");
		if (edit === "threshold" || edit === "combined")
			await page.getByLabel("最少问答样本数", { exact: true }).fill("30");
		if (edit === "reset")
			await page
				.getByRole("button", { name: "恢复默认值", exact: true })
				.click();
		if (edit === "recipient") await address.fill("draft@example.test");
		if (edit === "severity" || edit === "combined") {
			await page.getByRole("combobox").click();
			await page.getByRole("option", { name: "仅严重", exact: true }).click();
		}
		const save = page.getByRole("button", {
			name: "保存通知设置",
			exact: true,
		});
		await save.click();
		await expect(
			page.getByText("设置已更新，当前草稿已保留。请先刷新。", { exact: true }),
		).toBeVisible();
		await expect(save).toBeDisabled();
		await page
			.getByRole("button", { name: "刷新邮件通知", exact: true })
			.click();
		await page
			.getByRole("button", { name: "确认保留草稿", exact: true })
			.click();
		await expect(address).toHaveValue(
			edit === "recipient" ? "draft@example.test" : "new@example.test",
		);
		await expect(page.getByLabel("失败率警告", { exact: true })).toHaveValue(
			"0.2",
		);
		if (edit === "threshold" || edit === "combined")
			await expect(
				page.getByLabel("最少问答样本数", { exact: true }),
			).toHaveValue("30");
		await save.click();
		await expect(save).toBeDisabled();
		await expect.poll(() => patches.length).toBe(2);
		if (edit === "reset") {
			await expect(
				page.getByLabel("最少问答样本数", { exact: true }),
			).toHaveValue("");
			expect(patches[0]).toEqual({
				alert_thresholds: {},
				alert_policy_version: 0,
			});
			expect(patches[1]).toEqual({
				alert_thresholds: { ask_failure_rate_warning: 0.2 },
				alert_policy_version: 1,
			});
		} else if (edit === "threshold") {
			expect(patches[0]).toEqual({
				alert_thresholds: { ask_min_samples: 30 },
				alert_policy_version: 0,
			});
			expect(patches[1]).toEqual({
				alert_thresholds: {
					ask_min_samples: 30,
					ask_failure_rate_warning: 0.2,
				},
				alert_policy_version: 1,
			});
		} else {
			expect(patches[1].version).toBe(2);
			if (edit === "combined") {
				expect(patches[1].alert_thresholds).toEqual({
					ask_min_samples: 30,
					ask_failure_rate_warning: 0.2,
				});
				expect(patches[1].alert_policy_version).toBe(1);
			} else {
				expect(patches[1]).not.toHaveProperty("alert_thresholds");
				expect(patches[1]).not.toHaveProperty("alert_policy_version");
			}
			expect(view.settings.notify_recovery).toBe(false);
			expect(view.settings.recipients).toEqual([
				edit === "recipient" ? "draft@example.test" : "new@example.test",
			]);
			if (edit === "severity" || edit === "combined")
				expect(view.settings.minimum_severity).toBe("critical");
		}
		expect(errors).toEqual([]);
	});
}
