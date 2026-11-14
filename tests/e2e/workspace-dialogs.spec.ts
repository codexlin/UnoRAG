import { type Cookie, expect, type Page, test } from "@playwright/test";
import { chooseSelect } from "./select-helpers";

let cookies: Cookie[] = [];
let workspaceId = "";
let workspaceName = "";
let displayName = "";

test.beforeAll(async ({ browser }) => {
	const context = await browser.newContext({
		baseURL: process.env.UNORAG_E2E_BASE_URL,
	});
	try {
		const response = await context.request.post("/api/auth/session", {
			data: {
				email: process.env.UNORAG_E2E_ADMIN_EMAIL,
				password: process.env.UNORAG_E2E_ADMIN_PASSWORD,
			},
		});
		expect(response.ok()).toBe(true);
		displayName = (await response.json()).displayName;
		const list = await context.request.get("/api/workspaces");
		const current = (await list.json()).items.find(
			(item: { current: boolean }) => item.current,
		);
		expect(current).toBeTruthy();
		workspaceId = current.id;
		workspaceName = current.name;
		cookies = await context.cookies();
	} finally {
		await context.close();
	}
});

test.beforeEach(async ({ context }) => {
	await context.addCookies(cookies);
});

async function openNavigation(page: Page, mobile: boolean) {
	await expect(
		page.getByRole("button", { name: "外观设置", exact: true }),
	).toBeEnabled();
	if (mobile)
		await page
			.getByRole("button", { name: "切换侧边栏", exact: true })
			.first()
			.click();
}

async function expectFits(page: Page) {
	await expect
		.poll(() =>
			page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth + 1,
			),
		)
		.toBe(true);
	await expect
		.poll(() =>
			page
				.getByRole("dialog")
				.last()
				.evaluate((el) => {
					const rect = el.getBoundingClientRect();
					return (
						rect.left >= 0 &&
						rect.right <= innerWidth + 1 &&
						rect.top >= 0 &&
						rect.bottom <= innerHeight + 1 &&
						el.scrollWidth <= el.clientWidth + 1
					);
				}),
		)
		.toBe(true);
}

test("navigation has named destinations and a keyboard bypass in either layout", async ({
	page,
	isMobile,
}, info) => {
	await page.goto("/app/libraries");
	await expect(
		page.getByRole("button", { name: "外观设置", exact: true }),
	).toBeEnabled();
	await page.keyboard.press("Tab");
	const skip = page.getByRole("link", { name: "跳至主要内容", exact: true });
	await expect(skip).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.locator("#workspace-content")).toBeFocused();
	await openNavigation(page, isMobile);
	await expect(
		page.getByRole("link", { name: "UnoRAG 首页", exact: true }).locator("img"),
	).toBeVisible();
	await expect
		.poll(() =>
			page
				.getByRole("link", { name: "UnoRAG 首页", exact: true })
				.locator("img")
				.evaluate((image) => {
					const element = image as HTMLImageElement;
					return element.complete && element.naturalWidth > 0;
				}),
		)
		.toBe(true);
	for (const [name, href] of [
		["智能问答", "/app/ask"],
		["知识库", "/app/libraries"],
		["会话历史", "/app/archive"],
		["运行中心", "/app/operations"],
		["操作记录", "/app/audit"],
		["工作区", "/app/settings"],
	]) {
		const link = page.getByRole("link", { name, exact: true });
		await expect(link).toBeVisible();
		await expect(link).toHaveAttribute("href", href);
		const box = await link.boundingBox();
		expect(box?.height).toBeGreaterThanOrEqual(44);
		expect(box?.width).toBeGreaterThanOrEqual(44);
	}
	await page.screenshot({
		path: info.outputPath("named-navigation.png"),
		animations: "disabled",
	});
});

test("real account menu stays clickable in the icon rail and returns keyboard focus", async ({
	page,
	isMobile,
}) => {
	await page.goto("/app/libraries");
	await openNavigation(page, isMobile);
	const trigger = page
		.getByRole("button")
		.filter({ has: page.getByText(displayName, { exact: true }) })
		.first();
	await trigger.click();
	const menu = page.getByRole("menu");
	await expect(
		menu.getByRole("menuitem", { name: "退出登录", exact: true }),
	).toBeVisible();
	await expect(
		menu.getByRole("menuitem", { name: "工作区设置", exact: true }),
	).toHaveAttribute("href", "/app/settings");
	await expect
		.poll(() =>
			menu
				.getByRole("menuitem")
				.evaluateAll((items) =>
					items.every((item) => item.getBoundingClientRect().height >= 44),
				),
		)
		.toBe(true);
	await expect
		.poll(() =>
			page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth + 1,
			),
		)
		.toBe(true);
	await page.keyboard.press("Escape");
	await expect(menu).toHaveCount(0);
	await expect(trigger).toBeFocused();
});

test("workspace menu and create dialog preserve failures, drafts and focus without duplicate requests", async ({
	page,
	isMobile,
}, info) => {
	test.setTimeout(60_000);
	let failList = true;
	await page.route("**/api/workspaces", async (route) => {
		if (route.request().method() === "POST") {
			await route.fallback();
			return;
		}
		await route.fulfill(
			failList
				? { status: 503, json: { detail: "工作区列表暂不可用" } }
				: {
						json: {
							items: [
								{
									id: workspaceId,
									name: workspaceName,
									role: "owner",
									current: true,
								},
							],
							can_create: true,
						},
					},
		);
	});
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const posts: Array<{ key: string | undefined; body: unknown }> = [];
	await page.route("**/api/workspaces", async (route) => {
		if (route.request().method() !== "POST") {
			await route.fallback();
			return;
		}
		posts.push({
			key: route.request().headers()["idempotency-key"],
			body: route.request().postDataJSON(),
		});
		await held;
		await route.fulfill({
			status: 409,
			json: { detail: "此工作区标识已存在" },
		});
	});
	try {
		await page.goto("/app/libraries");
		await openNavigation(page, isMobile);
		const trigger = page.getByRole("button", {
			name: new RegExp(`工作区 ${workspaceName}`),
		});
		await trigger.click();
		await expect(page.getByRole("menu").getByRole("alert")).toHaveText(
			"工作区列表暂不可用",
		);
		failList = false;
		await page
			.getByRole("menuitem", { name: "重新加载工作区", exact: true })
			.click();
		await trigger.click();
		await page
			.getByRole("menuitem", { name: "新建工作区", exact: true })
			.click();
		const dialog = page.getByRole("dialog").last();
		await expect(dialog.getByLabel("名称", { exact: true })).toBeFocused();
		await dialog.getByLabel("名称", { exact: true }).fill("产品资料工作区");
		await dialog.getByLabel("标识", { exact: true }).fill("product-team");
		await dialog
			.getByRole("button", { name: "创建并进入", exact: true })
			.click();
		await expect(
			dialog.getByRole("button", { name: "创建中…", exact: true }),
		).toBeDisabled();
		await page.keyboard.press("Escape");
		await expect(dialog).toBeVisible();
		await expect.poll(() => posts.length).toBe(1);
		release();
		await expect(dialog.getByRole("alert")).toHaveText("此工作区标识已存在");
		await expect(dialog.getByLabel("名称", { exact: true })).toHaveValue(
			"产品资料工作区",
		);
		await dialog
			.getByRole("button", { name: "创建并进入", exact: true })
			.click();
		await expect.poll(() => posts.length).toBe(2);
		expect(posts[0].key).toBeTruthy();
		expect(posts[1]).toEqual(posts[0]);
		for (const theme of ["light", "dark"]) {
			await page.evaluate(
				(mode) =>
					document.documentElement.classList.toggle("dark", mode === "dark"),
				theme,
			);
			await expectFits(page);
			await page.screenshot({
				path: info.outputPath(`workspace-${theme}.png`),
				animations: "disabled",
			});
		}
		await dialog.getByRole("button", { name: "取消", exact: true }).click();
		await expect(trigger).toBeFocused();
	} finally {
		release();
	}
});

test("document ACL retry, filtered selection, saving feedback and readonly controls remain scoped", async ({
	page,
}, info) => {
	const stamp = "2026-11-13T00:00:00Z";
	const name = `权限核对-${"超长文件名".repeat(12)}.pdf`;
	await page.route("**/api/libraries", (route) =>
		route.fulfill({
			json: [
				{
					id: "acl-library",
					name: "权限资料",
					status: "ready",
					doc_count: 1,
					ready_count: 1,
					created_at: stamp,
					updated_at: stamp,
				},
			],
		}),
	);
	await page.route("**/api/libraries/acl-library/documents", (route) =>
		route.fulfill({
			json: [
				{
					id: "acl-doc",
					library_id: "acl-library",
					name,
					filename: name,
					status: "ready",
					content_type: "application/pdf",
					chunk_count: 3,
					created_at: stamp,
					updated_at: stamp,
				},
			],
		}),
	);
	await page.route("**/api/workspace/members", (route) =>
		route.fulfill({
			json: {
				members: [
					{
						userId: "member-a",
						displayName: "成员甲",
						email: "member-a@example.test",
						status: "active",
						role: "editor",
					},
					{
						userId: "member-b",
						displayName: "成员乙",
						email: "member-b@example.test",
						status: "active",
						role: "viewer",
					},
				],
				can_manage: true,
			},
		}),
	);
	let failing = true;
	let canEdit = true;
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const writes: unknown[] = [];
	await page.route(
		"**/api/libraries/acl-library/documents/acl-doc/acl",
		async (route) => {
			if (route.request().method() === "PUT") {
				writes.push(route.request().postDataJSON());
				await held;
				await route.fulfill({
					status: 503,
					json: { detail: "权限保存暂不可用" },
				});
				return;
			}
			await route.fulfill(
				failing
					? { status: 503, json: { detail: "权限读取暂不可用" } }
					: {
							json: {
								library_id: "acl-library",
								doc_id: "acl-doc",
								document_id: "acl-doc",
								scope: "restricted",
								principal_ids: ["member-a"],
								group_ids: [],
								principals: [],
								groups: [],
								projection: "none",
								can_edit: canEdit,
							},
						},
			);
		},
	);
	async function openAcl() {
		await page.goto("/app/libraries");
		await page.getByRole("button", { name: "操作", exact: true }).click();
		await page.getByRole("menuitem", { name: "谁可见", exact: true }).click();
		return page.getByRole("dialog").last();
	}
	try {
		let dialog = await openAcl();
		await expect(dialog.getByRole("alert")).toHaveText("权限读取暂不可用");
		failing = false;
		await dialog
			.getByRole("button", { name: "重试读取权限", exact: true })
			.click();
		await expect(
			dialog.getByRole("checkbox", { name: /成员甲/ }),
		).toBeChecked();
		await dialog.getByRole("checkbox", { name: /成员乙/ }).check();
		await dialog
			.getByRole("textbox", { name: "搜索可见成员", exact: true })
			.fill("成员乙");
		await expect(dialog.getByRole("checkbox")).toHaveCount(1);
		await expect(dialog.getByText("已选 2 位", { exact: true })).toBeVisible();
		await dialog.getByRole("button", { name: "保存", exact: true }).click();
		await expect(
			dialog.getByRole("button", { name: "保存中…", exact: true }),
		).toBeDisabled();
		await page.keyboard.press("Escape");
		await expect(dialog).toBeVisible();
		release();
		await expect(dialog.getByRole("alert")).toHaveText("权限保存暂不可用");
		expect(writes).toEqual([
			{
				scope: "restricted",
				principal_ids: ["member-a", "member-b"],
				group_ids: [],
			},
		]);
		await page.emulateMedia({ reducedMotion: "reduce" });
		for (const width of [320, 390, 768, 1440]) {
			await page.setViewportSize({ width, height: 700 });
			await expectFits(page);
			await page.screenshot({
				path: info.outputPath(`acl-${width}.png`),
				animations: "disabled",
			});
		}
		await page.evaluate(() => {
			document.documentElement.style.fontSize = "200%";
		});
		for (const width of [320, 768, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			await expectFits(page);
			await expect(dialog.getByText("仅指定成员", { exact: true })).toHaveCSS(
				"font-size",
				"28px",
			);
			await page.screenshot({
				path: info.outputPath(`acl-text-200-${width}.png`),
				animations: "disabled",
			});
		}
		await page.evaluate(() => {
			document.documentElement.style.fontSize = "";
		});
		await dialog.getByRole("button", { name: "取消", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "操作", exact: true }),
		).toBeFocused();
		canEdit = false;
		dialog = await openAcl();
		await expect(
			dialog.getByRole("button", { name: "保存", exact: true }),
		).toBeDisabled();
		await expect(
			dialog.getByRole("radio", { name: /工作区全员/ }),
		).toBeDisabled();
		await expect(
			dialog.getByRole("checkbox", { name: /成员甲/ }),
		).toBeDisabled();
		expect(writes).toHaveLength(1);
	} finally {
		release();
	}
});

test("workspace controls remain usable with doubled root text and constrained widths", async ({
	page,
}, info) => {
	test.setTimeout(60_000);
	await page.route("**/api/**", (route) =>
		["GET", "HEAD"].includes(route.request().method())
			? route.continue()
			: route.abort("blockedbyclient"),
	);
	const stamp = "2026-11-13T00:00:00Z";
	const settings = {
		answer_profile: "balanced",
		retrieval_enhancement: "auto",
		session_memory_enabled: true,
		evidence_requirement: "standard",
	};
	await page.route("**/api/workspace/settings", (route) =>
		route.fulfill({
			json: {
				ask: settings,
				defaults: settings,
				can_manage: false,
				policy_version: 1,
			},
		}),
	);
	await page.route("**/api/libraries", (route) =>
		route.fulfill({
			json: [
				{
					id: "text-resize-library",
					name: "知识库排版与文字放大验收",
					description: "经过加载的文档台账",
					status: "ready",
					doc_count: 1,
					ready_count: 1,
					created_at: stamp,
					updated_at: stamp,
				},
			],
		}),
	);
	await page.route("**/api/libraries/text-resize-library/documents", (route) =>
		route.fulfill({
			json: [
				{
					id: "text-resize-doc",
					library_id: "text-resize-library",
					name: "季度财务报告与检索说明",
					filename: "quarterly-finance.md",
					content_type: "text/markdown",
					status: "ready",
					chunk_count: 7,
					job_status: "failed",
					created_at: stamp,
					updated_at: stamp,
				},
			],
		}),
	);
	await page.route("**/api/rag/v1/threads?*", (route) =>
		route.fulfill({ json: [] }),
	);
	for (const path of ["/app/libraries", "/app/archive", "/app/settings"]) {
		await page.goto(path);
		await expect(
			page.getByRole("button", { name: "外观设置", exact: true }),
		).toBeEnabled();
		if (path === "/app/libraries") {
			await expect(
				page.getByRole("button", {
					name: "季度财务报告与检索说明",
					exact: true,
				}),
			).toBeVisible();
		} else if (path === "/app/archive") {
			await expect(
				page.getByText("还没有归档会话", { exact: true }),
			).toBeVisible();
		} else {
			await expect(
				page.getByRole("switch", { name: "对话记忆", exact: true }),
			).toBeVisible();
		}
		await page.evaluate(() => {
			document.documentElement.style.fontSize = "200%";
		});
		for (const width of [1440, 1024, 768, 320]) {
			await page.setViewportSize({ width, height: 900 });
			await expect
				.poll(() =>
					page.evaluate(
						() => document.documentElement.scrollWidth <= innerWidth + 1,
					),
				)
				.toBe(true);
			if (path === "/app/libraries") {
				for (const action of [
					page.getByRole("button", { name: "上传文档", exact: true }),
					page.getByRole("textbox", { name: "搜索文档", exact: true }),
				]) {
					await expect
						.poll(() =>
							action.evaluate(
								(el) =>
									el.clientWidth >= 100 && el.scrollWidth <= el.clientWidth + 1,
							),
						)
						.toBe(true);
				}
				await expect(page.getByText("处理失败", { exact: true })).toHaveCSS(
					"font-size",
					"28px",
				);
				await expect
					.poll(() =>
						page
							.getByRole("region", { name: "文档与任务统计", exact: true })
							.getByText("任务处理中", { exact: true })
							.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
					)
					.toBe(true);
			}
			if (path === "/app/settings") {
				for (const label of ["回答模式", "检索增强", "对话记忆", "证据要求"]) {
					const field = page
						.getByRole("region", { name: "问答策略", exact: true })
						.locator("label")
						.filter({ hasText: label })
						.first();
					await expect
						.poll(() =>
							field.evaluate((element) => {
								const bounds = element.getBoundingClientRect();
								return (
									bounds.width >= 100 &&
									bounds.height <=
										Number.parseFloat(getComputedStyle(element).lineHeight) * 2
								);
							}),
						)
						.toBe(true);
				}
			}
			await page.screenshot({
				path: info.outputPath(
					`${path.split("/").at(-1)}-text-200-${width}.png`,
				),
				animations: "disabled",
				fullPage: true,
			});
		}
		if (path === "/app/libraries") {
			await page
				.getByRole("button", { name: "新建知识库", exact: true })
				.first()
				.click();
			const dialog = page.getByRole("dialog").last();
			await expectFits(page);
			await dialog
				.getByRole("button", { name: "解析策略（质量 / 扫描件）", exact: true })
				.click();
			await chooseSelect(
				dialog.getByLabel("解析质量偏好", { exact: true }),
				"强制高质量解析",
			);
			await dialog.getByLabel("扫描件处理", { exact: true }).click();
			const options = page.getByRole("listbox");
			await expect(options).toBeVisible();
			await expect
				.poll(() =>
					options.evaluate((el) => {
						const bounds = el.getBoundingClientRect();
						return (
							bounds.left >= -1 &&
							bounds.right <= innerWidth + 1 &&
							Array.from(
								el.querySelectorAll<HTMLElement>('[role="option"]'),
							).every(
								(item) =>
									item.getBoundingClientRect().height >= 44 &&
									item.scrollWidth <= item.clientWidth + 1,
							)
						);
					}),
				)
				.toBe(true);
			await page.keyboard.press("Escape");
			await expectFits(page);
			await dialog.getByRole("button", { name: "取消", exact: true }).click();
		}
	}
});
