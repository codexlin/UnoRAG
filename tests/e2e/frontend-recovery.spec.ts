import { type Cookie, expect, type Page, test } from "@playwright/test";

import type { ApiDocument, ApiLibrary } from "../../src/lib/api";

let cookies: Cookie[] = [];
const errors = new WeakMap<Page, string[]>();

test.use({ reducedMotion: "reduce" });

test.beforeAll(async ({ browser }) => {
	const email = process.env.UNORAG_E2E_ADMIN_EMAIL;
	const password = process.env.UNORAG_E2E_ADMIN_PASSWORD;
	if (!email || !password)
		throw new Error("E2E administrator credentials required");
	const context = await browser.newContext({
		baseURL: process.env.UNORAG_E2E_BASE_URL,
	});
	try {
		const page = await context.newPage();
		await page.goto("/login");
		await page.getByLabel("邮箱").fill(email);
		await page.getByLabel("密码").fill(password);
		await page.getByRole("button", { name: "登录", exact: true }).click();
		await page.waitForURL((url) => url.pathname.startsWith("/app"));
		cookies = await context.cookies();
	} finally {
		await context.close();
	}
});

test.beforeEach(async ({ page, context }) => {
	await context.addCookies(cookies);
	const messages: string[] = [];
	errors.set(page, messages);
	page.on("pageerror", (error) => messages.push(error.message));
});

test.afterEach(async ({ page }) => {
	expect(errors.get(page), "no unhandled request rejection").toEqual([]);
});

for (const failedLoad of ["acl", "members"] as const) {
	test(`ACL fails closed when document B ${failedLoad} load fails after editing A`, async ({
		page,
	}) => {
		const stamp = "2026-01-01T00:00:00.000Z";
		const library: ApiLibrary = {
			id: "acl-library",
			name: "ACL fixture",
			status: "ready",
			doc_count: 2,
			ready_count: 2,
			created_at: stamp,
			updated_at: stamp,
		};
		const documents: ApiDocument[] = ["A", "B"].map((name) => ({
			id: `document-${name}`,
			library_id: library.id,
			name: `ACL ${name}`,
			filename: `${name}.txt`,
			content_type: "text/plain",
			status: "ready",
			chunk_count: 1,
			created_at: stamp,
			updated_at: stamp,
		}));
		let fail = false;
		let writes = 0;
		let saved: unknown;
		let releaseLoad = () => {};
		const loadGate = new Promise<void>((resolve) => {
			releaseLoad = resolve;
		});
		await page.route("**/api/libraries", (route) =>
			route.fulfill({ json: [library] }),
		);
		await page.route("**/api/libraries/*/documents", (route) =>
			route.fulfill({ json: documents }),
		);
		await page.route("**/api/workspace/members", async (route) => {
			if (fail && failedLoad === "members") {
				await loadGate;
				await route.fulfill({
					status: 503,
					json: { detail: "Members unavailable" },
				});
				return;
			}
			await route.fulfill({
				json: {
					can_manage: true,
					members: [
						{
							userId: "member-a",
							displayName: "Member A",
							email: "a@example.test",
							status: "active",
							role: "editor",
						},
					],
				},
			});
		});
		await page.route("**/api/libraries/*/documents/*/acl", async (route) => {
			const docId = new URL(route.request().url()).pathname.split("/")[5];
			if (route.request().method() === "PUT") {
				writes += 1;
				saved = { docId, ...route.request().postDataJSON() };
			} else if (fail && failedLoad === "acl") {
				await loadGate;
				await route.fulfill({
					status: 503,
					json: { detail: "ACL unavailable" },
				});
				return;
			}
			await route.fulfill({
				json: {
					library_id: library.id,
					doc_id: docId,
					document_id: docId,
					scope: docId === "document-A" ? "restricted" : "workspace",
					principal_ids: docId === "document-A" ? ["member-a"] : [],
					principals: [],
					groups: [],
					group_ids: [],
					can_edit: true,
					projection: "none",
				},
			});
		});
		async function openAcl(name: string) {
			await page
				.getByRole("row")
				.filter({ has: page.getByRole("button", { name, exact: true }) })
				.getByRole("button", { name: "操作", exact: true })
				.click();
			await page.getByRole("menuitem", { name: "谁可见", exact: true }).click();
		}
		const dialog = page.getByRole("dialog", { name: "谁可见", exact: true });
		try {
			await page.goto("/app/libraries");
			await openAcl("ACL A");
			await expect(
				dialog.getByRole("checkbox", { name: /Member A/ }),
			).toBeChecked();
			await expect(
				dialog.getByRole("button", { name: "保存", exact: true }),
			).toBeEnabled();
			await dialog.getByRole("button", { name: "取消", exact: true }).click();
			fail = true;
			await openAcl("ACL B");
			await expect(dialog.getByText("加载中…", { exact: true })).toBeVisible();
			await expect(
				dialog.getByRole("button", { name: "保存", exact: true }),
			).toBeDisabled();
			releaseLoad();
			await expect(
				dialog.getByText(
					failedLoad === "acl" ? "ACL unavailable" : "Members unavailable",
					{ exact: true },
				),
			).toBeVisible();
			await expect(dialog.getByRole("checkbox")).toHaveCount(0);
			await expect(
				dialog.getByRole("button", { name: "保存", exact: true }),
			).toBeDisabled();
			await dialog
				.getByRole("button", { name: "保存", exact: true })
				.dispatchEvent("click");
			expect(writes).toBe(0);
			await dialog.getByRole("button", { name: "取消", exact: true }).click();
			fail = false;
			await openAcl("ACL B");
			await expect(
				dialog.getByRole("radio", { name: /工作区全员/ }),
			).toBeChecked();
			await dialog.getByRole("button", { name: "保存", exact: true }).click();
			await expect(dialog).toBeHidden();
			expect(writes).toBe(1);
			expect(saved).toMatchObject({
				docId: "document-B",
				scope: "workspace",
				principal_ids: [],
			});
		} finally {
			releaseLoad();
		}
	});
}

for (const failure of ["network", "json"] as const) {
	test(`Ask settings recover from ${failure} load and save failures`, async ({
		page,
	}) => {
		const settings = {
			answer_profile: "balanced",
			retrieval_enhancement: "auto",
			session_memory_enabled: true,
			evidence_requirement: "standard",
		};
		let failLoad = true;
		let failSave = true;
		const patches: unknown[] = [];
		await page.route("**/api/workspace/settings", async (route) => {
			const saving = route.request().method() === "PATCH";
			if (saving) patches.push(route.request().postDataJSON());
			if (saving ? failSave : failLoad) {
				if (failure === "network") await route.abort("failed");
				else
					await route.fulfill({
						status: 200,
						contentType: "application/json",
						body: "{",
					});
				return;
			}
			await route.fulfill({
				json: {
					ask: saving ? { ...settings, answer_profile: "precise" } : settings,
					defaults: settings,
					policy_version: saving ? 2 : 1,
				},
			});
		});
		await page.goto("/app/settings");
		await expect(
			page.getByText("无法加载工作区设置", { exact: true }),
		).toBeVisible();
		const save = page.getByRole("button", { name: "保存", exact: true });
		await expect(save).toBeDisabled();
		failLoad = false;
		await page.getByRole("button", { name: "重试", exact: true }).click();
		const profile = page
			.getByRole("listitem")
			.filter({ has: page.getByText("回答模式", { exact: true }) })
			.getByRole("combobox");
		await expect(profile).toHaveValue("balanced");
		await profile.selectOption("precise");
		await save.click();
		await expect(
			page.getByText("保存失败，请重试", { exact: true }),
		).toBeVisible();
		await expect(save).toBeEnabled();
		await expect(profile).toHaveValue("precise");
		failSave = false;
		await save.click();
		await expect(page.getByText("已保存", { exact: true })).toBeVisible();
		await expect(profile).toHaveValue("precise");
		expect(patches).toEqual([
			{ ask: { answer_profile: "precise" } },
			{ ask: { answer_profile: "precise" } },
		]);
	});
}
