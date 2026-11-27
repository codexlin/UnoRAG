import { expect, test } from "@playwright/test";
import type { ApiLibrary, ApiThreadDetail } from "../../src/lib/api";
import { chooseSelect } from "./select-helpers";

const stamp = "2026-01-02T10:00:00.000Z";
const libraries: ApiLibrary[] = ["产品资料", "团队制度"].map((name, index) => ({
	id: `archive-library-${index}`,
	name,
	status: "ready",
	doc_count: 1,
	ready_count: 1,
	created_at: stamp,
	updated_at: stamp,
}));
const threads: ApiThreadDetail[] = libraries.map((library, index) => ({
	id: `archive-thread-${index}`,
	session_id: `archive-session-${index}`,
	library_id: library.id,
	title: index === 0 ? "产品上线的证据与审核记录" : "团队制度与保留期限",
	status: "archived",
	turn_count: 2,
	created_at: stamp,
	updated_at: index === 0 ? stamp : "2026-01-01T10:00:00.000Z",
	turns: [0, 1].map((round) => ({
		id: `archive-turn-${index}-${round}`,
		session_id: `archive-session-${index}`,
		thread_id: `archive-thread-${index}`,
		library_id: library.id,
		question: `问题 ${index + 1} / ${round + 1}`,
		answer: `历史回答 ${index + 1} / ${round + 1}。[3]`,
		citations: [
			{
				id: `archive-citation-${index}-${round}`,
				index: 3,
				title: "审核记录.pdf",
				filename: "审核记录.pdf",
				page: "7",
				section_path: "审核 / 发布条件",
				document_version_id: "historical-version-not-current",
				snippet: "批准发布的授权来源片段。",
				body: "批准发布的授权来源片段。应保留该次回答使用的版本。",
				score: 0.8,
			},
		],
		mode: "llm",
		refused: false,
		created_at: stamp,
	})),
}));

test.use({ reducedMotion: "reduce", timezoneId: "Asia/Shanghai" });

test.beforeEach(async ({ page }) => {
	const email = process.env.UNORAG_E2E_ADMIN_EMAIL;
	const password = process.env.UNORAG_E2E_ADMIN_PASSWORD;
	if (!email || !password)
		throw new Error("E2E administrator credentials required");
	await page.goto("/login");
	await page.getByLabel("邮箱").fill(email);
	await page.getByLabel("密码").fill(password);
	await page.getByRole("button", { name: "登录", exact: true }).click();
	await page.waitForURL((url) => url.pathname === "/app/ask");
	await page.route("**/api/libraries", (route) =>
		route.fulfill({ json: libraries }),
	);
	await page.route("**/api/rag/v1/threads?*", (route) =>
		route.fulfill({
			json: threads.map(({ turns: _turns, ...thread }) => thread),
		}),
	);
	await page.route("**/api/rag/v1/threads/*", (route) => {
		const id = new URL(route.request().url()).pathname.split("/").at(-1);
		const thread = threads.find((item) => item.id === id);
		return route.fulfill({ status: thread ? 200 : 404, json: thread ?? {} });
	});
});

test("archive search, library scope, round replay and evidence stay usable across layouts", async ({
	page,
}, testInfo) => {
	test.setTimeout(60_000);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/app/archive");
	const navigation = page.getByRole("complementary", { name: "会话历史导航" });
	const details = page.getByRole("region", { name: "会话详情", exact: true });
	const first = navigation.getByRole("button", {
		name: /产品上线的证据与审核记录/,
	});
	const second = navigation.getByRole("button", { name: /团队制度与保留期限/ });
	await expect(first).toBeVisible();
	await expect(
		navigation.getByRole("heading", { name: "2026年1月2日" }),
	).toBeVisible();
	await expect(
		navigation.getByRole("heading", { name: "2026年1月1日" }),
	).toBeVisible();
	await navigation.getByLabel("搜索会话").fill("不存在的标题");
	await expect(
		navigation.getByRole("status").filter({ hasText: "没有匹配" }),
	).toBeVisible();
	await navigation.getByLabel("搜索会话").fill("制度");
	await expect(first).toHaveCount(0);
	await expect(second).toBeVisible();
	await navigation.getByLabel("搜索会话").fill("");
	await chooseSelect(
		navigation.getByLabel("知识库", { exact: true }),
		libraries[1].name,
	);
	await expect(first).toHaveCount(0);
	await expect(second).toBeVisible();
	await chooseSelect(
		navigation.getByLabel("知识库", { exact: true }),
		"全部知识库",
	);
	await first.click();
	await expect(
		details.getByRole("article", { name: "回答", exact: true }),
	).toContainText("历史回答 1 / 2");
	await expect(details.getByRole("link", { name: "继续对话" })).toHaveAttribute(
		"href",
		"/app/ask?thread=archive-thread-0",
	);
	await chooseSelect(details.getByLabel("对话轮次"), "第 1 轮 · 问题 1 / 1");
	await expect(
		details.getByRole("article", { name: "回答", exact: true }),
	).toContainText("历史回答 1 / 1");
	const citation = details.getByRole("button", {
		name: "查看引用 3：审核记录.pdf",
		exact: true,
	});
	await citation.click();
	await expect(
		details
			.getByRole("listitem")
			.filter({ hasText: "historical-version-not-current" }),
	).toBeFocused();
	await expect(
		details.getByRole("region", { name: "引用来源", exact: true }),
	).toContainText("historical-version-not-current");
	await expect(
		details.getByRole("region", { name: "引用来源", exact: true }),
	).toContainText("批准发布的授权来源片段");
	await details.getByRole("button", { name: "返回回答", exact: true }).click();
	await expect(citation).toBeFocused();

	for (const width of [320, 390, 768, 1024, 1440]) {
		await page.setViewportSize({ width, height: 900 });
		await page.evaluate(() => new Promise(requestAnimationFrame));
		const back = details.getByRole("button", {
			name: "返回会话列表",
			exact: true,
		});
		if (await back.isVisible()) {
			await back.click();
			await expect(first).toBeFocused();
		}
		await expect(first).toBeVisible();
		await expect
			.poll(() =>
				first.evaluate((element) => element.getBoundingClientRect().height),
			)
			.toBeGreaterThanOrEqual(44);
		await first.click();
		await expect(
			details.getByRole("heading", { name: threads[0].title, exact: true }),
		).toBeVisible();
		await expect
			.poll(() =>
				details
					.getByRole("link", { name: "继续对话" })
					.evaluate((element) => element.getBoundingClientRect().height),
			)
			.toBeGreaterThanOrEqual(44);
		await expect
			.poll(() =>
				page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
			)
			.toBe(true);
		await expect
			.poll(() =>
				details.evaluate(
					(element) => element.scrollWidth <= element.clientWidth,
				),
			)
			.toBe(true);
		await page.screenshot({
			path: testInfo.outputPath(`archive-${width}.png`),
			animations: "disabled",
		});
	}
	expect(errors).toEqual([]);
});

test("a denied detail clears prior answers and citations and can be retried", async ({
	page,
}) => {
	await page.goto("/app/archive");
	const navigation = page.getByRole("complementary", { name: "会话历史导航" });
	const details = page.getByRole("region", { name: "会话详情", exact: true });
	await navigation
		.getByRole("button", { name: /产品上线的证据与审核记录/ })
		.click();
	await expect(
		details.getByRole("article", { name: "回答", exact: true }),
	).toContainText("历史回答 1 / 2");
	const back = details.getByRole("button", {
		name: "返回会话列表",
		exact: true,
	});
	if (await back.isVisible()) await back.click();
	let denied = true;
	await page.route("**/api/rag/v1/threads/archive-thread-1", (route) =>
		route.fulfill(
			denied
				? { status: 404, json: { detail: "thread not found" } }
				: { json: threads[1] },
		),
	);
	await navigation.getByRole("button", { name: /团队制度与保留期限/ }).click();
	await expect(details.getByRole("alert")).toContainText("可能已不可访问");
	await expect(
		details.getByRole("article", { name: "回答", exact: true }),
	).toHaveCount(0);
	await expect(
		details.getByText("批准发布的授权来源片段", { exact: false }),
	).toHaveCount(0);
	await expect(details.getByRole("link", { name: "继续对话" })).toHaveCount(0);
	denied = false;
	await details
		.getByRole("button", { name: "重试加载会话", exact: true })
		.click();
	await expect(
		details.getByRole("article", { name: "回答", exact: true }),
	).toContainText("历史回答 2 / 2");
});
