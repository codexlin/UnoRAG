import { type Cookie, expect, type Page, test } from "@playwright/test";
import {
	DEFAULT_WORKSPACE_EMAIL_SETTINGS,
	type WorkspaceNotificationsView,
	workspaceEmailSettingsSchema,
} from "../../src/lib/workspace-notifications";
import { chooseSelect } from "./select-helpers";

let cookies: Cookie[] = [];
const browserErrors = new WeakMap<Page, string[]>();

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
		await page.waitForURL((url) => url.pathname === "/app/ask");
		cookies = await context.cookies();
	} finally {
		await context.close();
	}
});

test.beforeEach(async ({ page, context }) => {
	await context.addCookies(cookies);
	const errors: string[] = [];
	browserErrors.set(page, errors);
	page.on("pageerror", (error) => errors.push(error.message));
});

test.afterEach(async ({ page }) => {
	await page.unrouteAll({ behavior: "wait" });
	expect(browserErrors.get(page)).toEqual([]);
});

function initialView(): WorkspaceNotificationsView {
	return {
		settings: { ...DEFAULT_WORKSPACE_EMAIL_SETTINGS, recipients: [] },
		version: 0,
		updated_at: null,
		transport: { status: "configured", checked_at: new Date().toISOString() },
		deliveries: [],
	};
}

async function noOverflow(page: Page) {
	await expect
		.poll(() =>
			page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth + 1,
			),
		)
		.toBe(true);
}

async function chooseSettings(page: Page, _id: string, label: string) {
	const select = page.getByRole("combobox", { name: "设置分区", exact: true });
	if (await select.isVisible()) await chooseSelect(select, label);
	else
		await page
			.getByRole("navigation", { name: "设置分区", exact: true })
			.getByRole("link", { name: label, exact: true })
			.click();
}

async function selectSettings(page: Page, id: string, label: string) {
	await chooseSettings(page, id, label);
	await expect(
		page.getByRole("region", { name: label, exact: true }),
	).toBeVisible();
}

test("settings keep grouped controls, one-time key clearing and audit navigation usable at every width", async ({
	page,
}, info) => {
	let settings = {
		answer_profile: "balanced",
		retrieval_enhancement: "auto",
		session_memory_enabled: true,
		evidence_requirement: "standard",
	};
	const patches: unknown[] = [];
	const roleChanges: unknown[] = [];
	let auditReads = 0;
	await page.route("**/api/workspace/settings", async (route) => {
		if (route.request().method() === "PATCH") {
			const body = route.request().postDataJSON();
			patches.push(body);
			settings = { ...settings, ...body.ask };
		}
		await route.fulfill({
			json: {
				ask: settings,
				defaults: settings,
				policy_version: 1,
				can_manage: true,
			},
		});
	});
	const displayName = "资料维护同事";
	const members = [
		{
			userId: "ui-fixture-editor",
			displayName,
			email: `${"long-member".repeat(8)}@example.test`,
			status: "active",
			role: "editor",
		},
	];
	await page.route("**/api/workspace/members", async (route) => {
		if (route.request().method() === "PATCH") {
			const body = route.request().postDataJSON();
			roleChanges.push(body);
			members[0].role = body.role;
		}
		await route.fulfill({ json: { members } });
	});
	await page.route("**/api/workspace/invites", (route) =>
		route.fulfill({ json: { invites: [] } }),
	);
	await page.route("**/api/workspace/keys", (route) =>
		route.fulfill({
			json:
				route.request().method() === "POST"
					? { key: "ui-fixture-not-a-real-service-key" }
					: { keys: [] },
		}),
	);
	await page.route("**/api/workspace/notifications", (route) =>
		route.fulfill({ json: initialView() }),
	);
	await page.route("**/api/workspace/audit?**", (route) => {
		auditReads++;
		return route.fulfill({ json: { items: [], next_cursor: null } });
	});
	await page.goto("/app/settings");
	const ask = page.getByRole("region", { name: "问答策略", exact: true });
	await expect(
		ask.getByRole("switch", { name: "对话记忆", exact: true }),
	).toBeChecked();
	await ask.getByRole("switch", { name: "对话记忆", exact: true }).uncheck();
	const answerMode = ask.getByRole("combobox", {
		name: "回答模式",
		exact: true,
	});
	await answerMode.focus();
	await page.keyboard.press("ArrowDown");
	await expect(
		page.getByRole("option", { name: "精确", exact: true }),
	).toBeVisible();
	await page.keyboard.press("End");
	await page.keyboard.press("Escape");
	await expect(answerMode).toBeFocused();
	await expect(answerMode).toHaveText("均衡");
	await page.keyboard.press("ArrowDown");
	await expect(answerMode).toHaveAttribute("aria-expanded", "true");
	const preciseOption = page.getByRole("option", {
		name: "精确",
		exact: true,
	});
	await expect(preciseOption).toBeVisible();
	await page.keyboard.press("Home");
	await expect(preciseOption).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(answerMode).toHaveText("精确");
	await ask.getByRole("button", { name: "保存", exact: true }).click();
	await expect(ask.getByRole("status")).toHaveText("已保存");
	expect(patches).toEqual([
		{ ask: { answer_profile: "precise", session_memory_enabled: false } },
	]);
	await expect(
		page.getByRole("region", { name: "成员与邀请", exact: true }),
	).toHaveCount(0);
	await selectSettings(page, "members", "成员与邀请");
	await page.getByRole("link", { name: "跳至主要内容", exact: true }).focus();
	await page.keyboard.press("Enter");
	await expect(
		page.getByRole("region", { name: "成员与邀请", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("region", { name: "问答策略", exact: true }),
	).toHaveCount(0);
	const memberPanel = page.getByRole("region", {
		name: "成员与邀请",
		exact: true,
	});
	await chooseSelect(
		memberPanel.getByRole("combobox", {
			name: `${displayName}的角色`,
			exact: true,
		}),
		"查看者",
	);
	await expect.poll(() => roleChanges.length).toBe(1);
	expect(roleChanges).toEqual([
		{ user_id: "ui-fixture-editor", role: "viewer" },
	]);
	await memberPanel.getByRole("button", { name: "移除", exact: true }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "取消", exact: true })
		.click();
	await expect(
		memberPanel.getByRole("button", { name: "移除", exact: true }),
	).toBeFocused();
	await selectSettings(page, "integrations", "集成密钥");
	const keys = page.getByRole("region", { name: "集成密钥", exact: true });
	await keys.getByRole("button", { name: "创建密钥", exact: true }).click();
	const keyDialog = page.getByRole("dialog", { name: /创建密钥|密钥已创建/ });
	await keyDialog
		.getByRole("button", { name: "创建密钥", exact: true })
		.click();
	await expect(
		keyDialog.getByText("ui-fixture-not-a-real-service-key", { exact: true }),
	).toBeVisible();
	await keyDialog
		.getByRole("button", { name: "清除明文", exact: true })
		.click();
	await page
		.getByRole("alertdialog", { name: "关闭并清除密钥明文？", exact: true })
		.getByRole("button", { name: "清除并关闭", exact: true })
		.click();
	await expect(
		page.getByText("ui-fixture-not-a-real-service-key", { exact: true }),
	).toHaveCount(0);
	await expect(keyDialog).toHaveCount(0);
	expect(auditReads).toBe(0);
	for (const width of [320, 390, 768, 1024, 1440]) {
		await page.setViewportSize({ width, height: 1000 });
		await selectSettings(page, "ask-settings", "问答策略");
		await noOverflow(page);
		await ask
			.getByRole("button", { name: "回答模式说明", exact: true })
			.click();
		await expect(
			page.getByRole("dialog").getByText(/所有模式都需要证据/),
		).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(
			ask.getByRole("button", { name: "回答模式说明", exact: true }),
		).toBeFocused();
		const save = ask.getByRole("button", { name: "保存", exact: true });
		const bounds = await save.boundingBox();
		expect(bounds?.height).toBeGreaterThanOrEqual(44);
		expect(bounds?.width).toBeGreaterThanOrEqual(44);
		await selectSettings(page, "notifications", "邮件通知");
		await noOverflow(page);
		if (width < 768) {
			const records = page.getByRole("region", {
				name: "最近邮件发送记录",
				exact: true,
			});
			await records.scrollIntoViewIfNeeded();
			await records.focus();
			await expect(records).toBeFocused();
			await records.evaluate((element) => {
				element.scrollLeft = 0;
			});
			await page.keyboard.press("ArrowRight");
			await expect
				.poll(() => records.evaluate((element) => element.scrollLeft))
				.toBeGreaterThan(0);
		}
	}
	await expect(page).toHaveURL(/#notifications$/);
	await expect(
		page.getByRole("heading", { name: "邮件通知", exact: true }),
	).toBeInViewport();
	await page.screenshot({
		path: info.outputPath("settings-sections.png"),
		fullPage: true,
	});
	await page
		.getByRole("link", { name: "操作记录", exact: true })
		.last()
		.click();
	await page.waitForURL(/\/app\/audit$/);
	await expect(page).toHaveURL(/\/app\/audit$/);
	await expect(
		page.getByRole("link", { name: "导出 CSV", exact: true }),
	).toBeVisible();
	await expect.poll(() => auditReads).toBeGreaterThan(0);
});

test("notification form saves settings and distinguishes queued from accepted (mock notification API)", async ({
	page,
}, info) => {
	let view = initialView();
	let queuedReads = 0;
	const tests: unknown[] = [];
	await page.route("**/api/workspace/notifications**", async (route) => {
		const request = route.request();
		if (request.method() === "GET") {
			if (view.deliveries.length && ++queuedReads >= 2) {
				view.deliveries[0] = {
					...view.deliveries[0],
					status: "sent",
					delivered_at: new Date().toISOString(),
					provider_message_id: "11111111-1111-4111-8111-111111111111",
					attempt: 1,
				};
			}
			await route.fulfill({ json: view });
		} else if (request.method() === "PATCH") {
			const body = request.postDataJSON();
			expect(body.version).toBe(view.version);
			view = {
				...view,
				version: view.version + 1,
				updated_at: new Date().toISOString(),
				settings: workspaceEmailSettingsSchema.parse(body.settings),
			};
			await route.fulfill({ json: view });
		} else if (
			request.method() === "POST" &&
			new URL(request.url()).pathname.endsWith("/test")
		) {
			tests.push(request.postDataJSON());
			const stamp = new Date().toISOString();
			view.deliveries = [
				{
					id: "22222222-2222-4222-8222-222222222222",
					purpose: "test",
					recipient: view.settings.recipients[0],
					status: "pending",
					attempt: 0,
					max_attempts: 5,
					error_code: null,
					created_at: stamp,
					delivered_at: null,
					next_attempt_at: stamp,
					provider_message_id: null,
				},
			];
			await route.fulfill({ status: 202, json: { queued: 1 } });
		} else await route.fulfill({ status: 405 });
	});
	await page.goto("/app/settings#notifications");
	const panel = page.getByRole("region", { name: "邮件通知", exact: true });
	await expect(
		panel.getByText("邮件服务：已配置", { exact: true }),
	).toBeVisible();
	await expect(
		panel.getByRole("button", { name: "发送测试邮件" }),
	).toBeDisabled();
	await panel.getByRole("button", { name: "添加收件邮箱" }).click();
	await panel.getByLabel("收件邮箱 1", { exact: true }).fill("ops@example");
	await expect(
		panel.getByRole("button", { name: "保存通知设置" }),
	).toBeDisabled();
	await panel
		.getByLabel("收件邮箱 1", { exact: true })
		.fill("Ops@Example.test");
	await panel.getByRole("button", { name: "保存通知设置" }).click();
	await expect(
		panel.getByText("邮件通知设置已保存", { exact: true }),
	).toBeVisible();
	await expect(panel.getByLabel("收件邮箱 1", { exact: true })).toHaveValue(
		"ops@example.test",
	);
	await panel.getByRole("button", { name: "发送测试邮件" }).click();
	await expect(
		panel.getByText("测试邮件已入队", { exact: true }),
	).toBeVisible();
	await expect(panel.getByText("等待发送", { exact: true })).toBeVisible();
	await expect(panel.getByText("服务商已接受", { exact: true })).toBeVisible({
		timeout: 10_000,
	});
	expect(tests).toEqual([{ version: 1 }]);
	expect(view.settings.enabled).toBe(false);
	await noOverflow(page);
	await panel.screenshot({ path: info.outputPath("email-notifications.png") });
});

test("settings protect drafts, block navigation during writes and reload only the active section", async ({
	page,
}, info) => {
	let settings = {
		answer_profile: "balanced",
		retrieval_enhancement: "auto",
		session_memory_enabled: true,
		evidence_requirement: "standard",
	};
	let memberReads = 0;
	let releaseWrite: (() => void) | undefined;
	const writeGate = new Promise<void>((resolve) => {
		releaseWrite = resolve;
	});
	let writeStarted = false;
	await page.route("**/api/workspace/settings", async (route) => {
		if (route.request().method() === "PATCH") {
			writeStarted = true;
			await writeGate;
			settings = { ...settings, ...route.request().postDataJSON().ask };
		}
		await route.fulfill({
			json: {
				ask: settings,
				defaults: settings,
				policy_version: 1,
				can_manage: true,
			},
		});
	});
	await page.route("**/api/workspace/members", (route) => {
		memberReads++;
		return route.fulfill({ json: { members: [] } });
	});
	await page.route("**/api/workspace/invites", (route) =>
		route.fulfill({ json: { invites: [] } }),
	);
	await page.goto("/app/settings#ask-settings");
	const answer = page.getByRole("combobox", { name: "回答模式", exact: true });
	await expect(answer).toHaveText("均衡");
	expect(memberReads).toBe(0);
	await chooseSelect(answer, "精确");
	await chooseSettings(page, "members", "成员与邀请");
	const confirm = page.getByRole("alertdialog", {
		name: "离开当前设置？",
		exact: true,
	});
	await expect(confirm).toContainText("未保存的更改将丢失");
	await confirm.getByRole("button", { name: "留在此页", exact: true }).click();
	await expect(answer).toHaveText("精确");
	await expect(page).toHaveURL(/#ask-settings$/);
	expect(memberReads).toBe(0);
	await chooseSettings(page, "members", "成员与邀请");
	await confirm
		.getByRole("button", { name: "放弃更改并离开", exact: true })
		.click();
	await expect(
		page.getByRole("region", { name: "成员与邀请", exact: true }),
	).toBeVisible();
	await expect.poll(() => memberReads).toBeGreaterThan(0);
	await selectSettings(page, "ask-settings", "问答策略");
	await expect(answer).toHaveText("均衡");
	await chooseSelect(answer, "精确");
	await page
		.getByRole("region", { name: "问答策略", exact: true })
		.getByRole("button", { name: "保存", exact: true })
		.click();
	try {
		await expect.poll(() => writeStarted).toBe(true);
		if (info.project.name === "mobile-chromium")
			await page
				.getByRole("button", { name: "切换侧边栏", exact: true })
				.first()
				.click();
		await page.getByRole("link", { name: "知识库", exact: true }).click();
		await expect(page).toHaveURL(/\/app\/settings#ask-settings$/);
		await expect(
			page.getByText("操作进行中，请稍候", { exact: true }),
		).toBeVisible();
	} finally {
		releaseWrite?.();
	}
	if (info.project.name === "mobile-chromium")
		await page.keyboard.press("Escape");
	await expect(
		page.getByRole("status").filter({ hasText: "已保存" }),
	).toBeVisible();
	await expect(
		page
			.getByRole("region", { name: "问答策略", exact: true })
			.getByRole("button", { name: "保存", exact: true }),
	).toBeDisabled();
	await noOverflow(page);
});

test("settings label cached health as unknown after a failed probe and recover on fresh data", async ({
	page,
}) => {
	const health = await (await page.request.get("/api/rag/health")).json();
	let failed = false;
	let failedReads = 0;
	await page.route("**/api/rag/health", (route) => {
		if (failed) failedReads++;
		return route.fulfill(
			failed
				? { status: 503, json: { detail: "unavailable" } }
				: {
						json: { ...health, status: "ok", degraded: false, ask_ready: true },
					},
		);
	});
	await page.clock.install();
	await page.goto("/app/settings#service");
	const service = page.getByRole("region", { name: "服务状态", exact: true });
	await expect(service.getByText("是", { exact: true })).toBeVisible();
	failed = true;
	await page.clock.fastForward(15_100);
	await expect.poll(() => failedReads).toBeGreaterThan(0);
	await page.clock.fastForward(1_100);
	await expect(service.getByRole("alert")).toContainText("上次成功快照");
	await expect(
		service.getByText("未知（探测失败）", { exact: true }),
	).toBeVisible();
	await expect(service.getByText("是", { exact: true })).toHaveCount(0);
	await expect(
		service.getByText("未知", { exact: true }).first(),
	).toBeVisible();
	failed = false;
	await page.clock.fastForward(15_100);
	await expect(service.getByText("是", { exact: true })).toBeVisible();
	await expect(service.getByRole("alert")).toHaveCount(0);
});

test("settings honor current server permissions and preserve drafts after permission revocation", async ({
	page,
}) => {
	let canManage = false;
	const settings = {
		answer_profile: "balanced",
		retrieval_enhancement: "auto",
		session_memory_enabled: true,
		evidence_requirement: "standard",
	};
	await page.route("**/api/workspace/settings", (route) =>
		route.fulfill(
			route.request().method() === "PATCH"
				? { status: 403, json: { detail: "工作区管理权限已撤销" } }
				: {
						json: {
							ask: settings,
							defaults: settings,
							policy_version: 1,
							can_manage: canManage,
						},
					},
		),
	);
	await page.goto("/app/settings#ask-settings");
	const panel = page.getByRole("region", { name: "问答策略", exact: true });
	const answer = panel.getByRole("combobox", { name: "回答模式", exact: true });
	await expect(answer).toBeDisabled();
	await expect(
		panel.getByText("只读 · 需管理员权限修改", { exact: true }),
	).toBeVisible();
	await expect(
		panel.getByRole("button", { name: "保存", exact: true }),
	).toHaveCount(0);
	canManage = true;
	await page.reload();
	await expect(answer).toBeEnabled();
	await chooseSelect(answer, "精确");
	await panel.getByRole("button", { name: "保存", exact: true }).click();
	await expect(panel.getByRole("alert")).toHaveText("工作区管理权限已撤销");
	await expect(answer).toHaveText("精确");
	await expect(answer).toBeDisabled();
	await expect(
		panel.getByRole("button", { name: "保存", exact: true }),
	).toHaveCount(0);
});

test("section changes replace the settings entry instead of filling browser history", async ({
	page,
}) => {
	test.setTimeout(60_000);
	await page.goto("/app/libraries");
	await expect(
		page.getByRole("button", { name: "外观设置", exact: true }),
	).toBeEnabled();
	await page.goto("/app/settings#service");
	await selectSettings(page, "members", "成员与邀请");
	await selectSettings(page, "service", "服务状态");
	await page.goBack({ waitUntil: "domcontentloaded" });
	await page.waitForURL(/\/app\/libraries$/);
	await expect(page).toHaveURL(/\/app\/libraries$/);
});

test("member invitation retries retain drafts and one-time links clear only after confirmation", async ({
	page,
}) => {
	let failMembers = true;
	let failInvite = true;
	let inviteWrites = 0;
	const inviteBodies: unknown[] = [];
	let releaseInvite: (() => void) | undefined;
	const inviteGate = new Promise<void>((resolve) => {
		releaseInvite = resolve;
	});
	await page.route("**/api/workspace/members", (route) =>
		route.fulfill(
			failMembers
				? { status: 503, json: { detail: "unavailable" } }
				: { json: { members: [] } },
		),
	);
	await page.route("**/api/workspace/invites", async (route) => {
		if (route.request().method() === "POST") {
			inviteWrites++;
			inviteBodies.push(route.request().postDataJSON());
			if (failInvite)
				return route.fulfill({
					status: 503,
					json: { detail: "邀请服务暂不可用" },
				});
			await inviteGate;
			return route.fulfill({
				json: {
					id: "ui-fixture-invite",
					inviteUrl: "/invite?token=ui-fixture-not-a-real-token",
					emailDelivery: { sent: true, provider: "mock" },
				},
			});
		}
		return route.fulfill({ json: { invites: [] } });
	});
	await page.goto("/app/settings#members");
	const panel = page.getByRole("region", { name: "成员与邀请", exact: true });
	await expect(panel.getByRole("alert")).toContainText("成员列表加载失败");
	await expect(panel.getByText("暂无成员", { exact: true })).toHaveCount(0);
	failMembers = false;
	await panel
		.getByRole("button", { name: "重试加载成员", exact: true })
		.click();
	await expect(panel.getByText("暂无成员", { exact: true })).toBeVisible();
	await panel.getByRole("button", { name: "邀请成员", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: /邀请成员|邀请已创建/ });
	await dialog
		.getByLabel("邮箱", { exact: true })
		.fill("colleague@example.test");
	await chooseSelect(dialog.getByLabel("角色", { exact: true }), "编辑者");
	await page.keyboard.press("Escape");
	await page
		.getByRole("alertdialog", { name: "放弃本次邀请？", exact: true })
		.getByRole("button", { name: "继续查看", exact: true })
		.click();
	await expect(dialog.getByLabel("邮箱", { exact: true })).toHaveValue(
		"colleague@example.test",
	);
	await dialog.getByRole("button", { name: "创建邀请", exact: true }).click();
	await expect(dialog.getByRole("alert")).toHaveText("邀请服务暂不可用");
	await expect(dialog.getByLabel("邮箱", { exact: true })).toHaveValue(
		"colleague@example.test",
	);
	failInvite = false;
	await dialog.getByRole("button", { name: "创建邀请", exact: true }).click();
	try {
		await expect.poll(() => inviteWrites).toBe(2);
		await expect(
			dialog.getByRole("button", { name: "创建中…", exact: true }),
		).toBeDisabled();
		await page.keyboard.press("Escape");
		await expect(dialog).toBeVisible();
		await expect(page.getByRole("alertdialog")).toHaveCount(0);
	} finally {
		releaseInvite?.();
	}
	await expect(dialog.getByRole("status")).toContainText("不代表已送达");
	await expect(dialog.getByText(/ui-fixture-not-a-real-token/)).toBeVisible();
	await dialog
		.getByRole("button", { name: "关闭", exact: true })
		.first()
		.click();
	await page
		.getByRole("alertdialog", { name: "关闭并清除邀请链接？", exact: true })
		.getByRole("button", { name: "清除并关闭", exact: true })
		.click();
	await expect(dialog).toHaveCount(0);
	await expect(page.getByText(/ui-fixture-not-a-real-token/)).toHaveCount(0);
	await panel.getByRole("button", { name: "邀请成员", exact: true }).click();
	await expect(dialog.getByLabel("邮箱", { exact: true })).toHaveValue("");
	await expect(dialog.getByLabel("角色", { exact: true })).toHaveText("查看者");
	await dialog.getByRole("button", { name: "取消", exact: true }).click();
	expect(inviteBodies).toEqual(
		Array(2).fill({
			email: "colleague@example.test",
			role: "editor",
			send_email: true,
		}),
	);
	await noOverflow(page);
});

test("notification conflicts preserve drafts and failed refresh clears readiness (mock notification API)", async ({
	page,
}) => {
	let view = {
		...initialView(),
		version: 1,
		settings: {
			...DEFAULT_WORKSPACE_EMAIL_SETTINGS,
			recipients: ["ops@example.test"],
		},
	};
	let conflict = true;
	let failedRead = false;
	await page.route("**/api/workspace/notifications**", async (route) => {
		if (route.request().method() === "GET") {
			await route.fulfill(
				failedRead
					? { status: 503, json: { detail: "unavailable" } }
					: { json: view },
			);
		} else if (route.request().method() === "PATCH") {
			if (conflict) {
				conflict = false;
				view = {
					...view,
					version: 2,
					settings: { ...view.settings, recipients: ["other@example.test"] },
				};
				await route.fulfill({
					status: 409,
					json: { code: "version_conflict" },
				});
			} else {
				const body = route.request().postDataJSON();
				expect(body.version).toBe(2);
				view = {
					...view,
					version: 3,
					settings: workspaceEmailSettingsSchema.parse(body.settings),
				};
				await route.fulfill({ json: view });
			}
		} else await route.fulfill({ status: 405 });
	});
	await page.goto("/app/settings#notifications");
	const panel = page.getByRole("region", { name: "邮件通知", exact: true });
	const address = panel.getByLabel("收件邮箱 1", { exact: true });
	await expect(address).toHaveValue("ops@example.test");
	await address.fill("draft@example.test");
	await panel.getByRole("button", { name: "保存通知设置" }).click();
	await expect(
		panel.getByRole("alert").filter({ hasText: "当前草稿已保留" }),
	).toBeVisible();
	await expect(address).toHaveValue("draft@example.test");
	await panel.getByRole("button", { name: "刷新邮件通知" }).click();
	await panel.getByRole("button", { name: "确认保留草稿" }).click();
	await panel.getByRole("button", { name: "保存通知设置" }).click();
	await expect(
		panel.getByText("邮件通知设置已保存", { exact: true }),
	).toBeVisible();
	expect(view.settings.recipients).toEqual(["draft@example.test"]);
	failedRead = true;
	await panel.getByRole("button", { name: "刷新邮件通知" }).click();
	await expect(
		panel.getByText("邮件服务：状态未知", { exact: true }),
	).toBeVisible();
	await expect(
		panel.getByRole("button", { name: "发送测试邮件" }),
	).toBeDisabled();
	await expect(
		panel.getByText("邮件服务：已配置", { exact: true }),
	).toHaveCount(0);
	await expect(address).toHaveValue("draft@example.test");
	await noOverflow(page);
});

test("a successful key write does not lock secret clearing behind its list refresh", async ({
	page,
}) => {
	let created = false;
	let releaseRead: (() => void) | undefined;
	const heldRead = new Promise<void>((resolve) => {
		releaseRead = resolve;
	});
	await page.route("**/api/workspace/keys", async (route) => {
		if (route.request().method() === "POST") {
			created = true;
			return route.fulfill({ json: { key: "ui-fixture-temporary-key" } });
		}
		if (created) await heldRead;
		return route.fulfill({ json: { keys: [] } });
	});
	await page.goto("/app/settings#integrations");
	await page
		.getByRole("region", { name: "集成密钥", exact: true })
		.getByRole("button", { name: "创建密钥", exact: true })
		.click();
	const dialog = page.getByRole("dialog", { name: /创建密钥|密钥已创建/ });
	await dialog.getByRole("button", { name: "创建密钥", exact: true }).click();
	try {
		await expect(
			dialog.getByText("ui-fixture-temporary-key", { exact: true }),
		).toBeVisible();
		await expect(
			dialog.getByRole("button", { name: "清除明文", exact: true }),
		).toBeEnabled();
		await dialog.getByRole("button", { name: "清除明文", exact: true }).click();
		await page
			.getByRole("alertdialog", { name: "关闭并清除密钥明文？", exact: true })
			.getByRole("button", { name: "清除并关闭", exact: true })
			.click();
		await expect(dialog).toHaveCount(0);
		await expect(
			page.getByText("ui-fixture-temporary-key", { exact: true }),
		).toHaveCount(0);
		await selectSettings(page, "service", "服务状态");
	} finally {
		releaseRead?.();
	}
});

test("rejected key reads clear sensitive UI and member responses can remove management controls", async ({
	page,
}) => {
	await page.route("**/api/workspace/keys", (route) =>
		route.fulfill({ status: 403, json: { detail: "forbidden" } }),
	);
	await page.route("**/api/workspace/members", (route) =>
		route.fulfill({
			json: {
				members: [
					{
						userId: "read-only-member",
						displayName: "资料维护同事",
						email: "colleague@example.test",
						status: "active",
						role: "viewer",
					},
				],
				can_manage: false,
			},
		}),
	);
	await page.route("**/api/workspace/invites", (route) =>
		route.fulfill({ json: { invites: [] } }),
	);
	await page.goto("/app/settings#integrations");
	const keys = page.getByRole("region", { name: "集成密钥", exact: true });
	await expect(keys.getByText(/当前无密钥管理权限/)).toBeVisible();
	await expect(
		keys.getByRole("button", { name: "创建密钥", exact: true }),
	).toHaveCount(0);
	await expect(keys.getByText("暂无有效密钥", { exact: true })).toHaveCount(0);
	await selectSettings(page, "members", "成员与邀请");
	const members = page.getByRole("region", { name: "成员与邀请", exact: true });
	await expect(
		members.getByText("资料维护同事", { exact: true }),
	).toBeVisible();
	await expect(members.getByText(/当前为只读权限/)).toBeVisible();
	await expect(
		members.getByRole("button", { name: "邀请成员", exact: true }),
	).toHaveCount(0);
	await expect(
		members.getByRole("combobox", { name: "资料维护同事的角色", exact: true }),
	).toHaveCount(0);
});

test("settings share readable theme tokens across desktop and mobile layouts", async ({
	page,
	isMobile,
}, info) => {
	test.setTimeout(90_000);
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
				can_manage: true,
				policy_version: 1,
			},
		}),
	);
	await page.setViewportSize(
		isMobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
	);
	await page.goto("/app/settings#ask-settings");
	const panel = page.getByRole("region", { name: "问答策略", exact: true });
	await expect(
		panel.getByRole("switch", { name: "对话记忆", exact: true }),
	).toBeEnabled();
	for (const [theme, label] of [
		["vercel", "Vercel"],
		["claude", "Claude"],
		["violet-bloom", "Violet Bloom"],
	]) {
		for (const [mode, modeLabel] of [
			["light", "浅色"],
			["dark", "深色"],
		]) {
			await page.getByRole("button", { name: "外观设置", exact: true }).click();
			const appearance = page.getByRole("dialog", {
				name: "外观",
				exact: true,
			});
			await appearance.getByRole("radio", { name: label, exact: true }).check();
			await appearance
				.getByRole("radio", { name: modeLabel, exact: true })
				.check();
			await page.keyboard.press("Escape");
			await expect(page.locator("html")).toHaveAttribute(
				"data-color-theme",
				theme,
			);
			await expect(
				panel.getByRole("heading", { name: "问答策略", exact: true }),
			).toHaveCSS("font-size", "20px");
			await noOverflow(page);
			await page.evaluate(() => document.fonts.ready);
			await page.mouse.move(0, 0);
			await page.screenshot({
				path: info.outputPath(`settings-${theme}-${mode}.png`),
				animations: "disabled",
			});
		}
	}
});
