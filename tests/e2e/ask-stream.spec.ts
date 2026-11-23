import {
	type Cookie,
	expect,
	type Locator,
	type Page,
	test,
} from "@playwright/test";

import type {
	ApiAskResponse,
	ApiAskTraceDetails,
	ApiCitation,
	ApiDocument,
	ApiHealth,
	ApiLibrary,
	ApiRetrievalDebug,
	ApiThreadDetail,
} from "../../src/lib/api";
import { COLOR_THEMES } from "../../src/lib/appearance";
import { reportedModelUsage } from "../fixtures/model-usage";
import { selectAppearanceRadio, textContrast } from "./appearance-assertions";

const stamp = "2026-01-01T00:00:00.000Z";
const libraries: ApiLibrary[] = ["Alpha", "Beta"].map((name) => ({
	id: `stream-${name.toLowerCase()}`,
	name: `Stream ${name}`,
	status: "ready",
	doc_count: 1,
	ready_count: 1,
	created_at: stamp,
	updated_at: stamp,
}));
const health: ApiHealth = {
	status: "ok",
	service: "controlled-browser-fixture",
	env: "test",
	ask_mode: "llm",
	effective_mode: "llm",
	graph: "fixture",
	degraded: false,
	has_llm_key: true,
	qdrant_ok: true,
	ask_ready: true,
	reasons: [],
	release: {
		version: "0.0.0-test",
		channel: "development",
		revision: "fixture",
		revision_short: "fixture",
		built_at: null,
		image_digest: null,
		dbos_application_version: null,
	},
};
const archivedThread: ApiThreadDetail = {
	id: "fixture-archive",
	session_id: "archive-session",
	library_id: "stream-beta",
	title: "Controlled archive",
	status: "archived",
	turn_count: 1,
	created_at: stamp,
	updated_at: stamp,
	turns: [
		{
			id: "archived-turn",
			session_id: "archive-session",
			thread_id: "fixture-archive",
			library_id: "stream-beta",
			question: "Archived fixture question",
			answer: "Saved archive answer",
			citations: [],
			mode: "llm",
			refused: false,
			created_at: stamp,
		},
	],
};
const previewCitation: ApiCitation = {
	id: "preview-snapshot",
	index: 1,
	title: "归档留存制度",
	filename: "retention-policy.pdf",
	page: "12",
	section_path: "归档 / 保留期限",
	doc_id: "preview-document",
	document_version_id: "11111111-2222-4333-8444-555555555555",
	row_start: 30,
	row_end: 35,
	snippet: "归档材料须保留三年，并记录交接人。",
	text: "完整来源正文：归档材料须保留三年，并记录交接人与归档日期。",
	score: 0.9,
};

type StreamControl = {
	frames: string[];
	released: number;
	reads: number;
	aborted: boolean;
	controller: ReadableStreamDefaultController<Uint8Array>;
};

declare global {
	interface Window {
		__askStreamFixtures: StreamControl[];
		__answerClipboardFixture: {
			writes: string[];
			pending: (() => void)[];
		};
	}
}

function frame(event: string, data: unknown) {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function meta(session = "fixture-session", thread?: string) {
	return frame("meta", {
		session_id: session,
		thread_id: thread,
		mode: "llm",
		refused: false,
	});
}

function done(
	answer: string,
	session = "fixture-session",
	thread?: string,
	citations: ApiCitation[] = [],
	retrievalDebug: ApiRetrievalDebug = {},
	traceDetails?: ApiAskTraceDetails,
) {
	return frame("done", {
		question: "fixture question",
		answer,
		session_id: session,
		thread_id: thread,
		citations,
		mode: "llm",
		refused: false,
		retrieval_debug: retrievalDebug,
		persisted: Boolean(thread),
		...traceDetails,
	} satisfies ApiAskResponse);
}

let cookies: Cookie[] = [];
const pageErrors = new WeakMap<Page, string[]>();

test.use({ reducedMotion: "reduce" });

test.beforeAll(async ({ browser }) => {
	const email = process.env.UNORAG_E2E_ADMIN_EMAIL?.trim();
	const password = process.env.UNORAG_E2E_ADMIN_PASSWORD?.trim();
	if (!email || !password) {
		throw new Error(
			"UNORAG_E2E_ADMIN_EMAIL and UNORAG_E2E_ADMIN_PASSWORD are required",
		);
	}
	const context = await browser.newContext({
		baseURL: process.env.UNORAG_E2E_BASE_URL,
		locale: "zh-CN",
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
	pageErrors.set(page, errors);
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (
			message.type() === "error" &&
			/hydration|cannot be a descendant|React error #418/i.test(message.text())
		) {
			errors.push(message.text());
		}
	});
});

async function installControlledStreams(page: Page) {
	await page.addInitScript(() => {
		const nativeFetch = window.fetch.bind(window);
		window.__askStreamFixtures = [];
		window.fetch = async (input, init) => {
			const url = new URL(
				input instanceof Request ? input.url : String(input),
				location.href,
			);
			const response = await nativeFetch(input, init);
			if (url.pathname !== "/api/rag/v1/ask/stream") return response;
			const frames = (await response.text())
				.split("\n\n")
				.filter(Boolean)
				.map((value) => `${value}\n\n`);
			let control: StreamControl;
			// route.fulfill buffers bodies. Gate its real SSE frames at the read boundary;
			// deliberately delay abort rejection so old catch/finally can race a retry.
			const body = new ReadableStream<Uint8Array>(
				{
					start(controller) {
						control = {
							frames,
							released: 0,
							reads: 0,
							aborted: init?.signal?.aborted ?? false,
							controller,
						};
						init?.signal?.addEventListener(
							"abort",
							() => {
								control.aborted = true;
							},
							{ once: true },
						);
						window.__askStreamFixtures.push(control);
					},
					pull() {
						control.reads += 1;
					},
				},
				{ highWaterMark: 0 },
			);
			return new Response(body, {
				status: response.status,
				headers: response.headers,
			});
		};
	});
}

test.afterEach(async ({ page }, testInfo) => {
	if (pageErrors.get(page)?.length) {
		await testInfo.attach("browser-errors", {
			body: pageErrors.get(page)?.join("\n\n") ?? "",
			contentType: "text/plain",
		});
	}
	expect(pageErrors.get(page), "uncaught browser errors").toEqual([]);
});

async function openAsk(page: Page, plans: string[][]) {
	await installControlledStreams(page);
	const requests: Record<string, unknown>[] = [];
	await page.route("**/api/rag/health", (route) =>
		route.fulfill({ json: health }),
	);
	await page.route("**/api/libraries", (route) =>
		route.fulfill({ json: libraries }),
	);
	await page.route("**/api/libraries/*/documents", (route) => {
		const libraryId = new URL(route.request().url()).pathname.split("/")[3];
		const documents: ApiDocument[] = [
			{
				id: `doc-${libraryId}`,
				library_id: libraryId,
				name: "Controlled document",
				filename: "fixture.txt",
				content_type: "text/plain",
				status: "ready",
				chunk_count: 1,
				created_at: stamp,
				updated_at: stamp,
			},
		];
		return route.fulfill({ json: documents });
	});
	await page.route("**/api/rag/v1/threads/*/continue", (route) =>
		route.fulfill({ json: archivedThread }),
	);
	await page.route("**/api/rag/v1/ask/stream", (route) => {
		requests.push(route.request().postDataJSON());
		const plan = plans[requests.length - 1];
		expect(
			plan,
			"unexpected Ask request must never reach a model",
		).toBeDefined();
		return route.fulfill({
			contentType: "text/event-stream",
			body: plan.join(""),
		});
	});
	await gotoAsk(page);
	await expect(page.getByRole("textbox")).toBeEnabled();
	await expect(
		page.getByRole("combobox", { name: "知识库", exact: true }),
	).toHaveValue("Stream Alpha");
	await page.clock.install();
	return requests;
}

async function gotoAsk(page: Page) {
	const response = await page.goto("/app/ask");
	expect(response?.status()).toBe(200);
	const initial = await page.evaluate(
		(html) => {
			const document = new DOMParser().parseFromString(html, "text/html");
			return {
				placeholder: document
					.querySelector('[role="status"]')
					?.textContent?.trim(),
				hasChooser: Boolean(
					document.querySelector('[role="combobox"][aria-label="知识库"]'),
				),
			};
		},
		(await response?.text()) ?? "",
	);
	expect(initial).toEqual({ placeholder: "加载问答…", hasChooser: false });
}

async function waitForStream(page: Page, index: number) {
	await expect
		.poll(() =>
			page.evaluate((i) => window.__askStreamFixtures[i]?.reads ?? 0, index),
		)
		.toBeGreaterThan(0);
}

async function submit(page: Page, question: string, index: number) {
	await page.getByRole("textbox").fill(question);
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await waitForStream(page, index);
	await closeSources(page);
}

async function closeSources(page: Page) {
	const close = page
		.getByRole("button", { name: "收起引用来源面板", exact: true })
		.last();
	if (await close.isVisible()) await close.click();
	await expect(
		page.getByRole("dialog", { name: "引用来源", exact: true }),
	).toBeHidden();
}

async function release(page: Page, index: number, count: number) {
	const before = await page.evaluate(
		({ index, count }) => {
			const control = window.__askStreamFixtures[index];
			const frames = control.frames.slice(
				control.released,
				control.released + count,
			);
			if (frames.length !== count) throw new Error("not enough fixture frames");
			control.released += count;
			const reads = control.reads;
			control.controller.enqueue(new TextEncoder().encode(frames.join("")));
			return reads;
		},
		{ index, count },
	);
	// A new pending read proves the production SSE parser consumed this batch.
	await expect
		.poll(() =>
			page.evaluate((i) => window.__askStreamFixtures[i].reads, index),
		)
		.toBeGreaterThan(before);
}

async function rejectStream(
	page: Page,
	index: number,
	message = "delayed old transport rejection",
) {
	await page.evaluate(
		({ index, message }) =>
			window.__askStreamFixtures[index].controller.error(new Error(message)),
		{ index, message },
	);
}

async function closeStream(page: Page, index: number) {
	await page.evaluate(
		(i) => window.__askStreamFixtures[i].controller.close(),
		index,
	);
}

async function pause(page: Page) {
	await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
}

async function expandAnswerSources(turn: Locator, count: number) {
	const region = turn.getByRole("region", { name: "回答依据", exact: true });
	const trigger = region.getByRole("button", {
		name: `回答依据 · ${count} 条`,
		exact: true,
	});
	if ((await trigger.getAttribute("aria-expanded")) !== "true") {
		await trigger.click();
	}
	await expect(trigger).toHaveAttribute("aria-expanded", "true");
	return region;
}

function citationPreview(page: Page) {
	return page.locator('[data-slot="hover-card-content"]:visible');
}

async function hoverCitation(page: Page, trigger: Locator) {
	await trigger.hover();
	await page.clock.runFor(400);
	const preview = citationPreview(page);
	await expect(preview).toBeVisible();
	return preview;
}

test("deterministic table answers open a scrollable table source with human row numbers", async ({
	page,
	isMobile,
}) => {
	await page.setViewportSize({ width: isMobile ? 320 : 1440, height: 900 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	const citation: ApiCitation = {
		...previewCitation,
		title: "设备预算表",
		record_type: "table",
		table_id: "budget",
		row_start: 0,
		row_end: 2,
		headers: [
			"设备名称",
			"规格参数与供应商型号",
			"单价（元）",
			"验收与交付要求",
		],
		rows: [
			[
				"服务器",
				"CloudMax CM-R7425 / 双处理器 / 256GB 内存",
				"120000",
				"交付后现场完成部署及验收",
			],
			["存储", "ArrayMax 双控制器 / 48TB", "30000", "完成数据迁移与备份验证"],
			["交换机", "NetworkMax 48 端口", "10000", "完成网络连通性验证"],
		],
		text: "设备名称 | 规格参数与供应商型号 | 单价（元） | 验收与交付要求\n服务器 | CloudMax CM-R7425 / 双处理器 / 256GB 内存 | 120000 | 交付后现场完成部署及验收",
	};
	const answer = "命中 1 行：\n- 设备名称：服务器，单价（元）：120000 [1]";
	await openAsk(page, [
		[
			meta(),
			frame("citations", [citation]),
			frame("token", answer),
			done(answer, undefined, undefined, [citation], {
				judge_mode: "deterministic_table_execution",
			}),
		],
	]);
	await submit(page, "预算表中服务器的单价是多少？", 0);
	await release(page, 0, 3);
	const anchor = page
		.getByRole("article")
		.getByRole("button", { name: "查看引用 1：设备预算表", exact: true });
	await expect(anchor).toBeVisible();
	await release(page, 0, 1);
	await closeStream(page, 0);
	const preview = await hoverCitation(page, anchor);
	await expect(preview).toContainText("表格行组 1 至 3");
	await page.clock.resume();
	if (isMobile) await anchor.tap();
	else await anchor.press("Enter");
	const panel = isMobile
		? page.getByRole("dialog", { name: "引用来源", exact: true })
		: page.getByRole("complementary", { name: "引用来源", exact: true });
	await expect(panel.getByText("1 至 3", { exact: true })).toBeVisible();
	const table = panel.getByRole("table", { name: citation.title, exact: true });
	await expect(table.getByRole("columnheader")).toHaveCount(4);
	await expect(table.getByRole("cell")).toHaveCount(12);
	await expect(
		table.getByRole("cell", { name: "120000", exact: true }),
	).toBeVisible();
	const scroll = panel.getByRole("region", {
		name: "表格来源片段",
		exact: true,
	});
	await scroll.focus();
	await expect(scroll).toBeFocused();
	expect(
		await scroll.evaluate(
			(element) => element.scrollWidth > element.clientWidth,
		),
	).toBe(true);
	await scroll.press("ArrowRight");
	await expect
		.poll(() => scroll.evaluate((element) => element.scrollLeft))
		.toBeGreaterThan(0);
	expect(
		await page.evaluate(
			() =>
				document.documentElement.scrollWidth <=
				document.documentElement.clientWidth + 1,
		),
	).toBe(true);
	await closeSources(page);
	await expect(anchor).toBeFocused();
});

test("answer Sources fold by default and retain same-file references with distinct versions", async ({
	page,
	isMobile,
}, testInfo) => {
	await page.setViewportSize({ width: isMobile ? 390 : 1440, height: 900 });
	const citations: ApiCitation[] = [
		previewCitation,
		{
			...previewCitation,
			id: "preview-second-version",
			index: 2,
			document_version_id: "66666666-7777-4888-8999-aaaaaaaaaaaa",
		},
		{
			...previewCitation,
			id: "preview-another-row-group",
			index: 3,
			row_start: 36,
			row_end: 40,
		},
	];
	const answer = "同一文件的三条独立依据。[1][2][3]";
	const requests = await openAsk(page, [
		[done(answer, undefined, undefined, citations)],
	]);
	await submit(page, "核对同名文件的依据", 0);
	await release(page, 0, 1);
	await closeStream(page, 0);
	const turn = page.locator("[data-turn-id]");
	const region = turn.getByRole("region", { name: "回答依据", exact: true });
	const trigger = region.getByRole("button", {
		name: "回答依据 · 3 条",
		exact: true,
	});
	const cards = region.getByRole("button", { name: /^查看引用 / });
	await expect(trigger).toHaveAttribute("aria-expanded", "false");
	await expect(cards).toHaveCount(0);
	await expect(
		turn.getByRole("article").getByRole("button", { name: /^查看引用 / }),
	).toHaveCount(3);
	await page.screenshot({
		path: testInfo.outputPath(`sources-collapsed-${isMobile ? 390 : 1440}.png`),
		animations: "disabled",
	});
	await expandAnswerSources(turn, 3);
	await expect(cards).toHaveCount(3);
	await page.screenshot({
		path: testInfo.outputPath(`sources-expanded-${isMobile ? 390 : 1440}.png`),
		animations: "disabled",
	});
	for (const citation of citations.slice(0, 2)) {
		const card = region.getByRole("button", {
			name: `查看引用 ${citation.index}：${citation.title}`,
			exact: true,
		});
		await expect(card).toHaveAttribute("data-citation-id", citation.id);
		await card.click();
		const panel = isMobile
			? page.getByRole("dialog", { name: "引用来源", exact: true })
			: page.getByRole("complementary", { name: "引用来源", exact: true });
		await expect(
			panel.getByText(citation.document_version_id ?? "", { exact: true }),
		).toBeVisible();
		await closeSources(page);
		await expect(card).toBeFocused();
	}
	await trigger.press("Enter");
	await expect(trigger).toHaveAttribute("aria-expanded", "false");
	await expect(cards).toHaveCount(0);
	await trigger.press("Enter");
	await expect(cards).toHaveCount(3);
	expect(requests).toHaveLength(1);
});

test("Sources disclosure state survives stream completion and is independent for each turn", async ({
	page,
}) => {
	const answer = "第一轮的依据。[1]";
	await openAsk(page, [
		[
			meta(),
			frame("citations", [previewCitation]),
			frame("token", answer),
			done(answer, undefined, undefined, [previewCitation]),
		],
		[done("第二轮的依据。[1]", undefined, undefined, [previewCitation])],
	]);
	await submit(page, "第一轮展开来源", 0);
	await release(page, 0, 3);
	const first = page.locator("[data-turn-id]").first();
	const firstRegion = await expandAnswerSources(first, 1);
	const firstTrigger = firstRegion.getByRole("button", {
		name: "回答依据 · 1 条",
		exact: true,
	});
	await release(page, 0, 1);
	await closeStream(page, 0);
	await expect(firstTrigger).toHaveAttribute("aria-expanded", "true");
	await expect(
		firstRegion.getByRole("button", { name: /^查看引用 1：/ }),
	).toBeVisible();
	await submit(page, "第二轮默认仍折叠", 1);
	await release(page, 1, 1);
	await closeStream(page, 1);
	const second = page.locator("[data-turn-id]").last();
	const secondTrigger = second.getByRole("button", {
		name: "回答依据 · 1 条",
		exact: true,
	});
	await expect(secondTrigger).toHaveAttribute("aria-expanded", "false");
	await expect(firstTrigger).toHaveAttribute("aria-expanded", "true");
	await expandAnswerSources(second, 1);
	await firstTrigger.click();
	await expect(firstTrigger).toHaveAttribute("aria-expanded", "false");
	await expect(secondTrigger).toHaveAttribute("aria-expanded", "true");
});

test("inline citation hover previews its snapshot without requests, selection or opening a source panel", async ({
	page,
	isMobile,
}, testInfo) => {
	await page.setViewportSize({ width: isMobile ? 390 : 1440, height: 900 });
	const target = { ...previewCitation, index: 2 };
	const first: ApiCitation = {
		...previewCitation,
		id: "preview-existing-selection",
		title: "既有来源",
		snippet: "第一份独立依据。",
	};
	await openAsk(page, [
		[done("核对两份制度。[1][2]", undefined, undefined, [first, target])],
	]);
	await submit(page, "只预览留存制度", 0);
	await release(page, 0, 1);
	await closeStream(page, 0);
	const turn = page.locator("[data-turn-id]");
	const region = await expandAnswerSources(turn, 2);
	const cards = region.getByRole("button", { name: /^查看引用 / });
	await expect(cards).toHaveCount(2);
	const selectionBefore = await cards.evaluateAll((elements) =>
		elements.map((element) => ({
			id: element.getAttribute("data-citation-id"),
			selected: element.getAttribute("aria-pressed"),
		})),
	);
	await pause(page);
	const apiRequests: string[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.pathname.startsWith("/api/")) apiRequests.push(url.pathname);
	});
	const preview = await hoverCitation(
		page,
		turn.getByRole("article").getByRole("button", { name: /^查看引用 2：/ }),
	);
	for (const value of [
		previewCitation.title,
		previewCitation.filename ?? "",
		previewCitation.section_path ?? "",
		"页 12",
		"表格行组 31 至 36",
		previewCitation.snippet,
		"回答所用版本",
		previewCitation.document_version_id ?? "",
	]) {
		await expect(preview).toContainText(value);
	}
	await expect(preview.getByText(/来源预览|来源片段/)).toBeVisible();
	await expect(preview).not.toContainText("完整来源正文");
	await expect(
		page.getByRole("dialog", { name: "引用来源", exact: true }),
	).toBeHidden();
	await expect(
		page.getByRole("complementary", { name: "引用来源", exact: true }),
	).toHaveCount(0);
	expect(
		await cards.evaluateAll((elements) =>
			elements.map((element) => ({
				id: element.getAttribute("data-citation-id"),
				selected: element.getAttribute("aria-pressed"),
			})),
		),
		"hovering another citation must not change the selected source",
	).toEqual(selectionBefore);
	await page.screenshot({
		path: testInfo.outputPath(`citation-preview-${isMobile ? 390 : 1440}.png`),
		animations: "disabled",
	});
	if (!isMobile) {
		await page.emulateMedia({ colorScheme: "dark" });
		await expect(page.locator("html")).toHaveClass(/dark/);
		await expect(preview).toBeVisible();
		await page.screenshot({
			path: testInfo.outputPath("citation-preview-dark-1440.png"),
			animations: "disabled",
		});
	}
	// Native exit animations need paint frames after the controlled-clock snapshot.
	await page.clock.resume();
	await page.mouse.move(0, 0);
	await expect(preview).toHaveCount(0);
	expect(
		apiRequests,
		"preview must use the delivered citation snapshot",
	).toEqual([]);
});

test("Sources and citation previews fit narrow and enlarged layouts across all themes", async ({
	page,
}, testInfo) => {
	test.setTimeout(90_000);
	await openAsk(page, [
		[
			done("可核对的依据。[1]", undefined, undefined, [previewCitation], {
				trace_id: "preview-theme-fixture",
				stages: [{ stage: "retrieve", duration_ms: 36, ok: true }],
			}),
		],
	]);
	await submit(page, "核对预览排版", 0);
	await release(page, 0, 1);
	await closeStream(page, 0);
	const turn = page.locator("[data-turn-id]");
	const sources = await expandAnswerSources(turn, 1);
	const trigger = turn
		.getByRole("article")
		.getByRole("button", { name: /^查看引用 1：/ });
	for (const { label: theme } of COLOR_THEMES) {
		for (const mode of ["浅色", "深色"]) {
			await page.getByRole("button", { name: "外观设置", exact: true }).click();
			await selectAppearanceRadio(
				page.getByRole("radio", { name: theme, exact: true }),
			);
			await selectAppearanceRadio(
				page.getByRole("radio", { name: mode, exact: true }),
			);
			await page.keyboard.press("Escape");
			for (const width of [320, 1440]) {
				await page.setViewportSize({ width, height: 900 });
				const preview = await hoverCitation(page, trigger);
				const box = await preview.boundingBox();
				if (!box) throw new Error("Preview has no visible bounds");
				expect(box.x).toBeGreaterThanOrEqual(0);
				expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
				expect(
					(await textContrast(preview.getByText("来源预览", { exact: true })))
						.ratio,
				).toBeGreaterThanOrEqual(4.5);
				expect(
					(await textContrast(preview.locator("dd"))).ratio,
				).toBeGreaterThanOrEqual(4.5);
				await page.keyboard.press("Escape");
				await expect(citationPreview(page)).toHaveCount(0);
				await expect(
					sources.getByRole("button", { name: /^回答依据/ }),
				).toHaveAttribute("aria-expanded", "true");
			}
			await turn.getByRole("button", { name: /^查看请求链路/ }).click();
			const drawer = page.getByRole("dialog", {
				name: "请求链路",
				exact: true,
			});
			await drawer.getByRole("button", { name: /阶段详情/ }).click();
			const duration = drawer
				.getByRole("region", { name: "阶段详情" })
				.locator('[data-slot="trace-description"]')
				.last();
			expect((await textContrast(duration)).ratio).toBeGreaterThanOrEqual(4.5);
			await page.keyboard.press("Escape");
		}
	}
	await page.setViewportSize({ width: 320, height: 900 });
	await page.evaluate(() => {
		document.documentElement.style.fontSize = "200%";
	});
	await page.getByRole("textbox").focus();
	const chooser = await page
		.getByRole("combobox", { name: "知识库", exact: true })
		.boundingBox();
	if (!chooser)
		throw new Error("Library chooser is missing after text enlargement");
	expect(chooser.width).toBeGreaterThanOrEqual(120);
	const sourceTitle = sources.locator('[data-slot="trace-title"]');
	expect(
		await sourceTitle.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
	).toBe(true);
	const preview = await hoverCitation(page, trigger);
	await expect(preview).toContainText(
		previewCitation.document_version_id ?? "",
	);
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth + 1,
		),
	).toBe(true);
	await expect
		.poll(async () => {
			const box = await preview.boundingBox();
			return Boolean(
				box &&
					box.x >= 0 &&
					box.x + box.width <= 321 &&
					box.y >= 0 &&
					box.y + box.height <= 901,
			);
		})
		.toBe(true);
	await preview.evaluate((el) => {
		el.scrollTop = el.scrollHeight;
	});
	await expect(preview.locator("dd")).toBeInViewport();
	await page.screenshot({
		path: testInfo.outputPath("citation-preview-320-enlarged.png"),
		animations: "disabled",
	});
});

test("inline citation click or touch and keyboard Enter close preview and preserve full-panel focus", async ({
	page,
	isMobile,
}) => {
	await openAsk(page, [
		[done("核对这份制度。[1]", undefined, undefined, [previewCitation])],
	]);
	await submit(page, "打开完整来源", 0);
	await release(page, 0, 1);
	await closeStream(page, 0);
	const trigger = page
		.getByRole("article")
		.getByRole("button", { name: /^查看引用 1：/ });
	await pause(page);
	await hoverCitation(page, trigger);
	await page.clock.resume();
	if (isMobile) await trigger.tap();
	else await trigger.click();
	const panel = isMobile
		? page.getByRole("dialog", { name: "引用来源", exact: true })
		: page.getByRole("complementary", { name: "引用来源", exact: true });
	await expect(panel).toBeVisible();
	await expect(citationPreview(page)).toHaveCount(0);
	await expect(
		panel.getByText(previewCitation.text ?? "", { exact: true }),
	).toBeVisible();
	await expect(
		panel.getByText(previewCitation.document_version_id ?? "", { exact: true }),
	).toBeVisible();
	await panel
		.getByRole("button", { name: "收起引用来源面板", exact: true })
		.focus();
	await page.keyboard.press("Escape");
	await expect(panel).toBeHidden();
	await expect(trigger).toBeFocused();
	await trigger.press("Enter");
	await expect(panel).toBeVisible();
	await expect(citationPreview(page)).toHaveCount(0);
	await closeSources(page);
	await expect(trigger).toBeFocused();
});

for (const terminal of ["complete", "error"] as const) {
	test(`inline citation preview refreshes its snapshot after stream ${terminal} without retaining stale metadata`, async ({
		page,
	}) => {
		const updated: ApiCitation = {
			...previewCitation,
			title: "最终留存制度快照",
			filename: "retention-final.pdf",
			section_path: "归档 / 最终范围",
			page: "18",
			row_start: 50,
			row_end: 55,
			document_version_id: "66666666-7777-4888-8999-aaaaaaaaaaaa",
			snippet: "最终片段须按已核对的留存范围执行。",
		};
		const answer = "可核对的留存内容。[1]";
		const finalFrames =
			terminal === "complete"
				? [done(answer, undefined, undefined, [updated])]
				: [
						frame("citations", [updated]),
						frame("error", { message: "preview fixture stream interruption" }),
					];
		await openAsk(page, [
			[
				meta(),
				frame("citations", [previewCitation]),
				frame("token", answer),
				...finalFrames,
			],
		]);
		await submit(page, `预览与 ${terminal} 同步`, 0);
		await release(page, 0, 3);
		const article = page.getByRole("article");
		const trigger = article.getByRole("button", { name: /^查看引用 1：/ });
		await expect(trigger).toBeVisible();
		await pause(page);
		const preview = await hoverCitation(page, trigger);
		await expect(preview).toContainText(previewCitation.snippet);
		await release(page, 0, finalFrames.length);
		await closeStream(page, 0);
		await expect(page.getByRole("textbox")).toBeEnabled();
		if (terminal === "error") {
			await expect(article.getByRole("alert")).toContainText(
				"回答生成失败，请重试",
			);
		}
		await expect(
			citationPreview(page).getByText(previewCitation.snippet, { exact: true }),
		).toHaveCount(0);
		await page.mouse.move(0, 0);
		await page.clock.runFor(200);
		const current = await hoverCitation(page, trigger);
		for (const value of [
			updated.title,
			updated.filename ?? "",
			updated.section_path ?? "",
			"页 18",
			"表格行组 51 至 56",
			updated.document_version_id ?? "",
			updated.snippet,
		]) {
			await expect(current).toContainText(value);
		}
		await expect(current).not.toContainText(previewCitation.title);
		await expect(current).not.toContainText(
			previewCitation.document_version_id ?? "",
		);
	});
}

test("library switch removes an open citation preview and late old frames cannot restore it", async ({
	page,
}) => {
	const next: ApiCitation = {
		...previewCitation,
		id: "beta-preview",
		title: "Beta 独立依据",
		snippet: "Beta 当前会话的来源片段。",
		document_version_id: "66666666-7777-4888-8999-aaaaaaaaaaaa",
	};
	await openAsk(page, [
		[
			meta(),
			frame("citations", [previewCitation]),
			frame("token", "Alpha 待完成。[1]"),
			done("Alpha 迟到回答。[1]", undefined, undefined, [previewCitation]),
		],
		[done("Beta 新会话。[1]", undefined, undefined, [next])],
	]);
	await submit(page, "Alpha 预览", 0);
	await release(page, 0, 3);
	const trigger = page
		.getByRole("article")
		.getByRole("button", { name: /^查看引用 1：/ });
	await expect(trigger).toBeVisible();
	await pause(page);
	await hoverCitation(page, trigger);
	const chooser = page.getByRole("combobox", { name: "知识库", exact: true });
	await chooser.fill("Beta");
	await page.getByRole("option", { name: "Stream Beta", exact: true }).click();
	await expect(page.getByRole("article")).toHaveCount(0);
	await expect(citationPreview(page)).toHaveCount(0);
	await release(page, 0, 1);
	await rejectStream(page, 0);
	await page.clock.runFor(400);
	await expect(citationPreview(page)).toHaveCount(0);
	await expect(
		page.getByRole("region", { name: "回答依据", exact: true }),
	).toHaveCount(0);
	await submit(page, "Beta 预览", 1);
	await release(page, 1, 1);
	await closeStream(page, 1);
	const current = await hoverCitation(
		page,
		page.getByRole("article").getByRole("button", { name: /^查看引用 1：/ }),
	);
	await expect(current).toContainText(next.title);
	await expect(current).toContainText(next.snippet);
	await expect(current).not.toContainText(previewCitation.title);
	await expect(current).not.toContainText(
		previewCitation.document_version_id ?? "",
	);
});

test("shadcn Suggestions fill the composer by pointer and keyboard without sending an Ask request", async ({
	page,
	isMobile,
}) => {
	const requests = await openAsk(page, []);
	const suggestion = page.getByRole("button", {
		name: "《Controlled document》里说了什么？",
		exact: true,
	});
	const input = page.getByRole("textbox");
	await expect(suggestion).toBeVisible();
	if (isMobile) await suggestion.tap();
	else await suggestion.click();
	await expect(input).toHaveValue("《Controlled document》里说了什么？");
	await expect(input).toBeEnabled();
	await expect(
		page.getByRole("button", { name: "发送", exact: true }),
	).toBeEnabled();
	await input.fill("未发送的自定义草稿");
	await suggestion.press("Enter");
	await expect(input).toHaveValue("《Controlled document》里说了什么？");
	await page.clock.runFor(400);
	expect(requests).toHaveLength(0);
	expect(await page.evaluate(() => window.__askStreamFixtures.length)).toBe(0);
	await expect(page.getByRole("article")).toHaveCount(0);
});

test("source snapshots open on demand across breakpoints and return focus to the citation", async ({
	page,
}, testInfo) => {
	const citation: ApiCitation = {
		id: "source-snapshot",
		index: 1,
		title: "数据保留制度",
		filename: "数据保留制度.pdf",
		page: "12",
		section_path: "归档 / 保留期限",
		document_version_id: "11111111-2222-4333-8444-555555555555",
		snippet: "保留期限为三年。",
		text: "业务归档材料的保留期限为三年，自归档之日起计算。",
		score: 0.9,
		bm25_score: 25.3,
	};
	const debug: ApiRetrievalDebug = {
		trace_id: "source-snapshot-trace",
		total_duration_ms: 1500,
		stages: [
			{ stage: "retrieve", duration_ms: 100, ok: true },
			{ stage: "generate", duration_ms: 900, ok: true },
		],
		model_usage: reportedModelUsage,
	};
	const answer = "归档材料保留三年。[1]";
	await openAsk(page, [
		[
			meta(),
			frame("token", answer),
			done(answer, undefined, undefined, [citation], debug),
		],
	]);
	await submit(page, "归档材料保留多久？", 0);
	await release(page, 0, 3);
	await closeStream(page, 0);
	await expect(page.getByRole("textbox")).toBeEnabled();
	await expect(
		page.getByRole("dialog", { name: "引用来源", exact: true }),
	).toBeHidden();
	await expect(
		page.getByRole("complementary", { name: "引用来源", exact: true }),
	).toHaveCount(0);
	const trigger = page
		.getByRole("article")
		.getByRole("button", { name: /^查看引用 1：/ });
	for (const width of [320, 768, 1280, 1440]) {
		await page.setViewportSize({ width, height: 900 });
		await trigger.click();
		const panel =
			width >= 1280
				? page.getByRole("complementary", { name: "引用来源", exact: true })
				: page.getByRole("dialog", { name: "引用来源", exact: true });
		await expect(panel).toBeVisible();
		await expect(
			panel.getByRole("heading", { name: "来源片段", exact: true }),
		).toBeVisible();
		await expect(
			panel.getByText(citation.text ?? "", { exact: true }),
		).toBeVisible();
		await expect(
			panel.getByText(citation.document_version_id ?? "", { exact: true }),
		).toBeVisible();
		await expect
			.poll(() =>
				page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
			)
			.toBe(true);
		await page.screenshot({
			path: testInfo.outputPath(`source-${width}.png`),
			animations: "disabled",
		});
		await panel
			.getByRole("button", { name: "收起引用来源面板", exact: true })
			.focus();
		await page.keyboard.press("Escape");
		await expect(panel).toBeHidden();
		await expect(trigger).toBeFocused();
	}
	await page.getByRole("button", { name: /^查看请求链路/ }).click();
	const trace = page.getByRole("dialog", { name: "请求链路", exact: true });
	await expect(
		trace.getByRole("heading", { name: "请求链路", exact: true }),
	).toBeFocused();
	await expect(
		trace.getByRole("region", { name: "阶段耗时", exact: true }),
	).toBeVisible();
	await expect(
		trace.getByText("2 步 · 顺序累计", { exact: true }),
	).toBeVisible();
	await expect(
		trace.getByRole("region", { name: "模型 Token 用量", exact: true }),
	).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("request-trace.png"),
		animations: "disabled",
	});
	await page.emulateMedia({ colorScheme: "dark" });
	await expect(page.locator("html")).toHaveClass(/dark/);
	await page.screenshot({
		path: testInfo.outputPath("request-trace-dark.png"),
		animations: "disabled",
	});
});

test("transport failure preserves the received answer and its usable citations", async ({
	page,
}) => {
	const partial = "已收到的回答片段。[1]";
	const citation: ApiCitation = {
		id: "partial-source",
		index: 1,
		title: "制度",
		snippet: "来源片段",
		score: 0.8,
	};
	await openAsk(page, [
		[meta(), frame("citations", [citation]), frame("token", partial)],
	]);
	await submit(page, "流中断的测试", 0);
	await release(page, 0, 3);
	const article = page.getByRole("article");
	const citationButton = article.getByRole("button", { name: /^查看引用 1：/ });
	await expect(citationButton).toBeVisible();
	await citationButton.focus();
	const originalButton = await citationButton.elementHandle();
	await rejectStream(page, 0, "读取服务器数据失败");
	await expect(article.getByRole("alert")).toContainText(
		"回答连接中断，请重试",
	);
	await expect(article).toContainText("已收到的回答片段。");
	expect(await originalButton?.evaluate((element) => element.isConnected)).toBe(
		true,
	);
	await expect(citationButton).toBeFocused();
	await expect(
		article.getByRole("button", { name: /^查看引用 1：/ }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "重试", exact: true }),
	).toBeEnabled();
});

test("source focus survives stream completion while its panel remains open", async ({
	page,
	isMobile,
}) => {
	const citation: ApiCitation = {
		id: "during-stream-source",
		index: 1,
		title: "处理中来源",
		snippet: "来源内容",
		score: 0.8,
	};
	const answer = "可以核对的内容。[1]";
	await openAsk(page, [
		[
			meta(),
			frame("citations", [citation]),
			frame("token", answer),
			done(`## ${answer}`, undefined, undefined, [citation]),
		],
	]);
	await submit(page, "生成时查看来源", 0);
	await release(page, 0, 3);
	const trigger = page
		.getByRole("article")
		.getByRole("button", { name: /^查看引用 1：/ });
	await trigger.click();
	const panel = isMobile
		? page.getByRole("dialog", { name: "引用来源", exact: true })
		: page.getByRole("complementary", { name: "引用来源", exact: true });
	await expect(panel).toBeVisible();
	await release(page, 0, 1);
	await closeStream(page, 0);
	await panel
		.getByRole("button", { name: "收起引用来源面板", exact: true })
		.click();
	await expect(panel).toBeHidden();
	await expect(trigger).toBeFocused();
});

test("Trace details preserve measured stages, keyboard disclosures and raw diagnostics", async ({
	page,
}, testInfo) => {
	await openAsk(page, [
		[
			done("本次检索未完成。", undefined, undefined, [], {
				trace_id: "stage-disclosure-fixture",
				total_duration_ms: 48,
				stages: [
					{ stage: "route", duration_ms: 12, ok: true },
					{ stage: "retrieve", duration_ms: 36, ok: false },
				],
			}),
		],
	]);
	await submit(page, "查看阶段诊断", 0);
	await release(page, 0, 1);
	await closeStream(page, 0);
	await page.getByRole("button", { name: /^查看请求链路/ }).click();
	const drawer = page.getByRole("dialog", { name: "请求链路", exact: true });
	await expect(drawer.getByRole("region", { name: "阶段耗时" })).toContainText(
		"2 步 · 顺序累计",
	);
	const details = drawer.getByRole("region", { name: "阶段详情" });
	const route = details.getByRole("button", { name: /问题路由/ });
	const retrieve = details.getByRole("button", { name: /知识检索/ });
	await expect(route).toHaveAttribute("aria-expanded", "false");
	await expect(route).toContainText("12ms");
	await expect(retrieve).toHaveAttribute("aria-expanded", "true");
	await expect(retrieve).toContainText("36ms");
	await expect(details.getByText("retrieve", { exact: true })).toBeVisible();
	await route.press("Enter");
	await expect(route).toHaveAttribute("aria-expanded", "true");
	await expect(details.getByText("route", { exact: true })).toBeVisible();
	await retrieve.click();
	await expect(retrieve).toHaveAttribute("aria-expanded", "false");
	await expect(
		drawer.getByText("stage-disclosure-fixture", { exact: true }),
	).toBeVisible();
	const raw = drawer.getByRole("button", { name: "原始 JSON", exact: true });
	await expect(raw).toHaveAttribute("aria-expanded", "false");
	await raw.press("Enter");
	const json = drawer.getByRole("region", { name: "原始 JSON 内容" });
	await expect(json).toContainText('"duration_ms": 36');
	await json.focus();
	await expect(json).toBeFocused();
	await page.screenshot({
		path: testInfo.outputPath("trace-stage-disclosures.png"),
		animations: "disabled",
	});
});

test("Ask trace shows model token usage even without legacy stages or trace ID", async ({
	page,
}, testInfo) => {
	await openAsk(page, [
		[
			done("Usage fixture answer", undefined, undefined, [], {
				model_usage: reportedModelUsage,
				judge_input_tokens: 1_234_567,
				judge_output_tokens: 9_876_543,
			}),
		],
	]);
	await submit(page, "Usage fixture question", 0);
	await release(page, 0, 1);
	await closeStream(page, 0);
	await expect(page.getByRole("textbox")).toBeEnabled();
	await page.clock.resume();
	await page.getByRole("button", { name: /^查看请求链路/ }).click();
	const panel = page.getByRole("region", { name: "模型 Token 用量" });
	await expect(panel.getByText("已上报", { exact: true })).toBeVisible();
	await expect(panel.locator("dl").first().locator("dd")).toHaveText([
		"2,000",
		"200",
		"2,200",
	]);
	await expect(panel.getByRole("listitem")).toHaveCount(2);
	await expect(panel).toContainText("rewrite-fixture");
	await expect(panel).toContainText("fixture-provider");
	await expect(panel).toContainText("包含在输入内");
	await expect(
		page.getByRole("dialog").getByText(/裁决 Token（旧记录）|Judge tokens/),
	).toHaveCount(0);
	await panel.scrollIntoViewIfNeeded();
	expect(
		await panel.evaluate(
			(element) => element.scrollWidth <= element.clientWidth + 1,
		),
	).toBe(true);
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth + 1,
		),
	).toBe(true);
	await page.screenshot({
		path: testInfo.outputPath("ask-model-usage.png"),
		fullPage: true,
	});
});

test("stream completion narrows Sources to referenced sparse indices without refetching", async ({
	page,
	isMobile,
}, testInfo) => {
	const first: ApiCitation = {
		...previewCitation,
		id: "unused-stream-candidate",
		index: 1,
		title: "未引用的候选来源",
		text: "第一份候选的独立来源快照。",
		snippet: "第一份候选的独立来源快照。",
	};
	const second: ApiCitation = {
		...previewCitation,
		id: "referenced-stream-source",
		index: 2,
		title: "最终回答依据",
		text: "第二份来源的最终引用快照。",
		snippet: "第二份来源的最终引用快照。",
	};
	const answer = "完成后只保留实际引用的依据。[2]";
	const requests = await openAsk(page, [
		[
			meta(),
			frame("citations", [first, second]),
			frame("token", answer),
			done(answer, undefined, undefined, [second]),
		],
	]);
	await submit(page, "核对最终回答的引用来源", 0);
	await release(page, 0, 3);
	const turn = page.locator("[data-turn-id]").first();
	const initialSources = await expandAnswerSources(turn, 2);
	await expect(
		initialSources.getByRole("button", { name: /^查看引用 / }),
	).toHaveCount(2);
	await pause(page);
	const apiRequests: string[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.pathname.startsWith("/api/")) apiRequests.push(url.pathname);
	});
	await initialSources
		.getByRole("button", { name: `查看引用 1：${first.title}`, exact: true })
		.click();
	const panel = isMobile
		? page.getByRole("dialog", { name: "引用来源", exact: true })
		: page.getByRole("complementary", { name: "引用来源", exact: true });
	await expect(
		panel.getByText(first.text ?? "", { exact: true }),
	).toBeVisible();
	await release(page, 0, 1);
	await closeStream(page, 0);
	// A removed selection clears the panel; it must not silently select another source.
	await expect(panel.getByText("尚未选择引用", { exact: true })).toBeVisible();
	await expect(panel.getByText(first.text ?? "", { exact: true })).toHaveCount(
		0,
	);
	await expect(panel.getByText(second.text ?? "", { exact: true })).toHaveCount(
		0,
	);
	// Let Base UI finish the sheet exit transition before freezing timers again.
	await page.clock.resume();
	await closeSources(page);
	await pause(page);
	const finalSources = await expandAnswerSources(turn, 1);
	await expect(
		finalSources.getByRole("button", { name: /^查看引用 / }),
	).toHaveCount(1);
	await expect(
		finalSources.getByRole("button", {
			name: `查看引用 2：${second.title}`,
			exact: true,
		}),
	).toHaveAttribute("data-citation-id", second.id);
	await expect(turn.getByRole("button", { name: /^查看引用 1：/ })).toHaveCount(
		0,
	);
	const inline = turn.getByRole("article").getByRole("button", {
		name: `查看引用 2：${second.title}`,
		exact: true,
	});
	await expect(inline).toHaveText("2");
	await inline.click();
	await page.clock.runFor(400);
	await expect(panel).toHaveCSS("opacity", "1");
	await expect(
		panel.getByText(second.text ?? "", { exact: true }),
	).toBeVisible();
	await expect(panel.getByText(first.text ?? "", { exact: true })).toHaveCount(
		0,
	);
	await page.screenshot({
		path: testInfo.outputPath("final-citation-subset.png"),
		animations: "disabled",
	});
	expect(requests).toHaveLength(1);
	expect(
		apiRequests,
		"source selection must use the delivered snapshots",
	).toEqual([]);
});

test("stream updates preserve the explicitly selected source and its originating turn", async ({
	page,
	isMobile,
}) => {
	const first: ApiCitation = {
		id: "selection-one",
		index: 1,
		title: "第一份依据",
		snippet: "第一份来源正文",
		score: 0.8,
	};
	const second: ApiCitation = {
		id: "selection-two",
		index: 2,
		title: "第二份依据",
		snippet: "第二份来源正文",
		score: 0.8,
	};
	const finalized = { ...second, snippet: "第二份来源最终快照" };
	const next = { ...second, index: 1, snippet: "另一轮的来源快照" };
	await openAsk(page, [
		[
			meta(),
			frame("citations", [first, second]),
			frame("token", "核对两份依据。[1][2]"),
			done("核对两份依据。[1][2]", undefined, undefined, [first, finalized]),
		],
		[
			meta(),
			frame("citations", [next]),
			done("新一轮的回答。[1]", undefined, undefined, [next]),
		],
	]);
	await submit(page, "比较两份依据", 0);
	await release(page, 0, 3);
	const source = page
		.getByRole("article")
		.first()
		.getByRole("button", { name: /^查看引用 2：/ });
	await page
		.getByRole("article")
		.first()
		.getByRole("button", { name: /^查看引用 1：/ })
		.focus();
	// Some touch browsers activate a button without moving the current focus.
	await source.dispatchEvent("click");
	const panel = isMobile
		? page.getByRole("dialog", { name: "引用来源", exact: true })
		: page.getByRole("complementary", { name: "引用来源", exact: true });
	await expect(
		panel.getByText("第二份来源正文", { exact: true }),
	).toBeVisible();
	await release(page, 0, 1);
	await closeStream(page, 0);
	await expect(
		panel.getByText("第二份来源最终快照", { exact: true }),
	).toBeVisible();
	await closeSources(page);
	await expect(source).toBeFocused();
	await submit(page, "接着问第二轮", 1);
	await source.click();
	await release(page, 1, 3);
	await closeStream(page, 1);
	await expect(
		panel.getByText("第二份来源最终快照", { exact: true }),
	).toBeVisible();
	await expect(
		panel.getByText("另一轮的来源快照", { exact: true }),
	).toHaveCount(0);
	await closeSources(page);
	await expect(source).toBeFocused();
	await expandAnswerSources(page.locator("[data-turn-id]").first(), 2);
	await expandAnswerSources(page.locator("[data-turn-id]").last(), 1);
	await expect(
		page
			.locator("[data-turn-id]")
			.first()
			.locator('[data-citation-id="selection-two"][aria-pressed="true"]'),
	).toHaveCount(1);
	await expect(
		page
			.locator("[data-turn-id]")
			.last()
			.locator('[data-citation-id="selection-two"][aria-pressed="true"]'),
	).toHaveCount(0);
});

test("a delayed long archive starts at the latest answer instead of consuming the empty-state scroll", async ({
	page,
}) => {
	await openAsk(page, []);
	let releaseArchive = () => {};
	const gate = new Promise<void>((resolve) => {
		releaseArchive = resolve;
	});
	const answer = `${"历史依据内容。\n\n".repeat(100)}归档末尾 END`;
	const detail = {
		...archivedThread,
		library_id: libraries[0].id,
		turns: [{ ...archivedThread.turns[0], answer }],
	};
	await page.route("**/api/rag/v1/threads/*/continue", async (route) => {
		await gate;
		await route.fulfill({ json: detail });
	});
	try {
		const request = page.waitForRequest("**/api/rag/v1/threads/*/continue");
		await page.evaluate(() =>
			history.pushState(null, "", "/app/ask?thread=fixture-archive"),
		);
		await request;
		await expect(page.getByRole("textbox")).toBeDisabled();
		releaseArchive();
		await expect(page.getByRole("article")).toContainText("归档末尾 END");
		const viewport = page.getByRole("region", {
			name: "问答阅读区",
			exact: true,
		});
		await expect
			.poll(() =>
				viewport.evaluate(
					(el) => el.scrollHeight - el.clientHeight - el.scrollTop,
				),
			)
			.toBeLessThan(10);
	} finally {
		releaseArchive();
	}
});

test("programmatic composer changes resize after library switches and sample selection", async ({
	page,
}) => {
	await openAsk(page, []);
	const input = page.getByRole("textbox");
	await input.fill("多行草稿\n".repeat(30));
	await expect
		.poll(() => input.evaluate((el) => el.getBoundingClientRect().height))
		.toBeGreaterThan(180);
	const chooser = page.getByRole("combobox", { name: "知识库", exact: true });
	await chooser.fill("Beta");
	await page.getByRole("option", { name: "Stream Beta" }).click();
	await expect(input).toHaveValue("");
	await expect
		.poll(() => input.evaluate((el) => el.getBoundingClientRect().height))
		.toBeLessThan(100);
	await input.fill("又一份多行草稿\n".repeat(30));
	await page
		.getByRole("button", {
			name: "《Controlled document》里说了什么？",
			exact: true,
		})
		.click();
	await expect(input).toHaveValue("《Controlled document》里说了什么？");
	await expect
		.poll(() => input.evaluate((el) => el.getBoundingClientRect().height))
		.toBeLessThan(100);
});

test("Ask library loading and failed reads never present a genuinely empty library list", async ({
	page,
}) => {
	let releaseLibraries = () => {};
	const gate = new Promise<void>((resolve) => {
		releaseLibraries = resolve;
	});
	await page.route("**/api/rag/health", (route) =>
		route.fulfill({ json: health }),
	);
	await page.route("**/api/libraries", async (route) => {
		await gate;
		await route.fulfill({ status: 503, json: { detail: "List unavailable" } });
	});
	try {
		await gotoAsk(page);
		await expect(
			page.getByRole("heading", { name: "正在加载知识库", exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("heading", { name: "还没有知识库", exact: true }),
		).toHaveCount(0);
		await expect(
			page.getByRole("link", { name: "去创建知识库", exact: true }),
		).toHaveCount(0);
		releaseLibraries();
		await expect(
			page.getByRole("heading", { name: "知识库加载失败", exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("link", { name: "去创建知识库", exact: true }),
		).toHaveCount(0);
		await expect(page.getByRole("textbox")).toBeDisabled();
	} finally {
		releaseLibraries();
	}
});

test("legacy Ask trace retains labelled Judge-only token metadata", async ({
	page,
}) => {
	await openAsk(page, [
		[
			done("Legacy usage answer", undefined, undefined, [], {
				trace_id: "legacy-usage-fixture",
				judge_input_tokens: 12,
				judge_output_tokens: 3,
			}),
		],
	]);
	await submit(page, "Legacy usage question", 0);
	await release(page, 0, 1);
	await closeStream(page, 0);
	await expect(page.getByRole("textbox")).toBeEnabled();
	await page.clock.resume();
	await page.getByRole("button", { name: /^查看请求链路/ }).click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByText("裁决 Token（旧记录）", { exact: true }),
	).toBeVisible();
	await expect(dialog.getByText("12 / 3", { exact: true })).toBeVisible();
	const panel = dialog.getByRole("region", { name: "模型 Token 用量" });
	await expect(panel.getByText("未记录", { exact: true })).toBeVisible();
	await expect(panel).toContainText("不能视为零消耗");
});

test("archiving keeps the live trace in memory and restores only stored diagnostics after reload", async ({
	page,
}, testInfo) => {
	// Two complete document loads share this functional journey's budget.
	test.slow();
	const archiveId = "fixture-usage-archive";
	const sessionId = "usage-roundtrip-session";
	const liveQuery = "Live-only rewritten query";
	await openAsk(page, [
		[
			done(
				"Archived usage answer",
				sessionId,
				undefined,
				[],
				{ model_usage: reportedModelUsage },
				{
					retrieval_inspection: [],
					rewritten_question: liveQuery,
					judge_summary: {
						mode: null,
						sufficient: true,
						verdict: "generate",
						conflict_status: null,
						citation_validation: "passed",
					},
				},
			),
		],
	]);
	let archived: ApiThreadDetail | undefined;
	let archivePayload: unknown;
	let resumeReads = 0;
	await page.route("**/api/rag/v1/threads", (route) => {
		const payload = route.request().postDataJSON() as {
			session_id: string;
			library_id: string;
			title: string;
			turns: ApiThreadDetail["turns"];
		};
		archivePayload = payload;
		// Resume from the submitted turns so a missing debug field cannot be supplied by the fixture.
		archived = {
			...archivedThread,
			id: archiveId,
			session_id: payload.session_id,
			library_id: payload.library_id,
			title: payload.title,
			turn_count: payload.turns.length,
			turns: payload.turns.map((turn, index) => ({
				...turn,
				id: `usage-turn-${index}`,
				session_id: payload.session_id,
				thread_id: archiveId,
				created_at: stamp,
			})),
		};
		return route.fulfill({ json: archived });
	});
	await page.route(`**/api/rag/v1/threads/${archiveId}/continue`, (route) => {
		if (!archived) throw new Error("archive must be saved before resume");
		resumeReads += 1;
		return route.fulfill({ json: archived });
	});
	const traceToggle = page.getByRole("switch", { name: "检索透视" });
	await traceToggle.click();
	await expect(traceToggle).toBeChecked();
	await submit(page, "Archive usage roundtrip", 0);
	await release(page, 0, 1);
	await closeStream(page, 0);
	await expect(page.getByRole("textbox")).toBeEnabled();
	await page.clock.resume();
	await page.getByRole("button", { name: "归档当前会话", exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`/app/ask\\?thread=${archiveId}$`));
	await expect(page.getByRole("textbox")).toBeEnabled();
	expect(archivePayload).toMatchObject({
		session_id: sessionId,
		library_id: "stream-alpha",
		turns: [
			{
				question: "Archive usage roundtrip",
				answer: "Archived usage answer",
				retrieval_debug: { model_usage: reportedModelUsage },
			},
		],
	});
	expect(JSON.stringify(archivePayload)).not.toContain(liveQuery);
	expect(JSON.stringify(archivePayload)).not.toContain("retrieval_inspection");
	await expect.poll(() => resumeReads).toBeGreaterThan(0);
	await expect(traceToggle).toBeChecked();
	await expect(traceToggle).toBeEnabled();
	await page.getByRole("button", { name: /^查看请求链路/ }).click();
	await expect(page.getByText(liveQuery, { exact: true })).toBeVisible();
	const readsBeforeReload = resumeReads;
	await page.reload();
	// Development effect replays may abort and restart a read; assert fresh data, not an exact fetch count.
	await expect.poll(() => resumeReads).toBeGreaterThan(readsBeforeReload);
	await expect(
		page.getByText("Archived usage answer", { exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: /^查看请求链路/ }).click();
	await expect(page.getByText(liveQuery, { exact: true })).toHaveCount(0);
	const panel = page.getByRole("region", { name: "模型 Token 用量" });
	await expect(panel.getByText("已上报", { exact: true })).toBeVisible();
	await expect(panel.locator("dl").first().locator("dd")).toHaveText([
		"2,000",
		"200",
		"2,200",
	]);
	await expect(panel.getByRole("listitem")).toHaveCount(2);
	await expect(panel).toContainText("rewrite-fixture");
	await expect(panel).toContainText("fixture-provider");
	await page.screenshot({
		path: testInfo.outputPath("archived-model-usage.png"),
		fullPage: true,
	});
});

test("long answer text, links and inline code fit during streaming and after completion", async ({
	page,
}, testInfo) => {
	const marker = `RECOVERY_PROOF_${"ABCDEF0123456789".repeat(8)}`;
	const word = `DOCUMENT_${"LONGTOKEN".repeat(24)}`;
	const url = `https://example.org/${"long-path-".repeat(24)}`;
	const answer = `Inline \`${marker}\`[1]\n\n${word}\n\n[${url}](${url})`;
	const citation: ApiCitation = {
		id: "wrapping-source",
		index: 1,
		title: "Wrapping source",
		snippet: "A controlled rendering fixture.",
		score: 1,
	};
	await openAsk(page, [
		[
			meta(),
			frame("token", answer),
			done(answer, undefined, undefined, [citation]),
		],
	]);
	await submit(page, "Rendering fixture", 0);
	await page.mouse.move(0, 0);
	await expect(page.getByRole("tooltip")).toBeHidden();
	await release(page, 0, 2);
	const article = page.getByRole("article");
	const code = article.locator("p code");
	await expect(code).toHaveText(marker);

	async function expectContentFits() {
		for (const content of [
			code,
			article.getByText(word, { exact: true }),
			article.getByRole("link", { name: url, exact: true }),
		]) {
			const fits = await content.evaluate((element) => {
				const container = element.closest("article");
				if (!container) throw new Error("answer article missing");
				const bounds = container.getBoundingClientRect();
				const range = document.createRange();
				range.selectNodeContents(element);
				return Array.from(range.getClientRects()).every(
					(rect) =>
						rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1,
				);
			});
			expect(
				fits,
				"every text fragment must remain inside the answer, not merely be clipped",
			).toBe(true);
		}
		const layout = await page.evaluate(() => ({
			width: document.documentElement.scrollWidth,
			viewport: window.innerWidth,
			asides: Array.from(document.querySelectorAll("aside")).map((element) => ({
				width: element.getBoundingClientRect().width,
				overflowX: getComputedStyle(element).overflowX,
				contain: getComputedStyle(element).contain,
			})),
			overflowing: Array.from(document.querySelectorAll("body *"))
				.filter(
					(element) =>
						!element.closest('aside[aria-hidden="true"]') &&
						element.getBoundingClientRect().right > window.innerWidth + 1,
				)
				.map((element) => ({
					tag: element.tagName,
					class: element.getAttribute("class"),
					right: element.getBoundingClientRect().right,
				}))
				.slice(0, 15),
		}));
		if (layout.width > layout.viewport + 1) {
			await testInfo.attach("answer-overflow-layout", {
				body: JSON.stringify(layout, null, 2),
				contentType: "application/json",
			});
		}
		await expect
			.poll(
				() =>
					page.evaluate(
						() => document.documentElement.scrollWidth <= window.innerWidth + 1,
					),
				{
					message:
						"the page must fit after the source-panel tooltip finishes closing",
				},
			)
			.toBe(true);
	}

	await expectContentFits();
	await release(page, 0, 1);
	await closeStream(page, 0);
	await expect(page.getByRole("textbox")).toBeEnabled();
	await expectContentFits();
	if (testInfo.project.use.isMobile) {
		for (const width of [320, 360, 393]) {
			await page.setViewportSize({ width, height: 851 });
			await expectContentFits();
		}
	}
	await expect(code).toHaveText(marker);
	await expect(
		article.getByRole("link", { name: url, exact: true }),
	).toHaveAttribute("href", url);
	const screenshot = testInfo.outputPath("answer-wrapping.png");
	await page.screenshot({ path: screenshot, fullPage: true });
	await testInfo.attach("answer wrapping", {
		path: screenshot,
		contentType: "image/png",
	});
	await article.getByRole("button", { name: /^查看引用 1：/ }).click();
	const panel = testInfo.project.use.isMobile
		? page.getByRole("dialog", { name: "引用来源", exact: true })
		: page.getByRole("complementary", { name: "引用来源", exact: true });
	await expect(
		panel.getByText(citation.snippet, { exact: true }),
	).toBeVisible();
});

test("long fenced code stays scrollable and copies unchanged with or without a language", async ({
	page,
	context,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const snippets = [
		`const token = "${"CODE_TOKEN_".repeat(40)}";\nconsole.log(token);`,
		`  ${"PLAIN_CODE_".repeat(40)}\n    indented line`,
	];
	const answer = `\`\`\`ts\n${snippets[0]}\n\`\`\`\n\n\`\`\`\n${snippets[1]}\n\`\`\``;
	await openAsk(page, [[meta(), frame("token", answer), done(answer)]]);
	await submit(page, "Code fixture", 0);
	await release(page, 0, 3);
	await closeStream(page, 0);
	await expect(page.getByRole("textbox")).toBeEnabled();
	const article = page.getByRole("article");
	const blocks = article.locator("pre");
	await expect(blocks).toHaveCount(2);
	for (const [index, snippet] of snippets.entries()) {
		const block = blocks.nth(index);
		await expect(block.locator("code")).toHaveText(snippet, {
			useInnerText: false,
		});
		// Shiki can replace pre between locator resolution and evaluation; select and inspect atomically.
		const layout = await page.evaluate((index) => {
			const element =
				document.querySelectorAll<HTMLElement>("article pre")[index];
			if (!element) throw new Error("code block missing during scroll check");
			const bounds = element.getBoundingClientRect();
			element.scrollLeft = element.scrollWidth;
			return {
				fits:
					element.scrollWidth > element.clientWidth &&
					getComputedStyle(element).overflowX === "auto" &&
					bounds.right <= window.innerWidth + 1,
				scrollLeft: element.scrollLeft,
			};
		}, index);
		expect(layout.fits).toBe(true);
		expect(layout.scrollLeft).toBeGreaterThan(0);
		await article
			.getByRole("button", { name: /^(复制|已复制)$/ })
			.nth(index)
			.click();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
			snippet,
		);
	}
});

test("answer copy preserves complete raw Markdown and citation numbers with temporary feedback", async ({
	page,
	context,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const answer =
		"## 原始 Markdown\n\n**保留格式**与引用顺序。[2][1]\n\n- 第一项\n- 第二项\n\n`const sample = 1;`\n\n[资料](https://example.com/reference)\n\n尾段  \n保留换行。";
	const citations: ApiCitation[] = [1, 2].map((index) => ({
		id: `copy-source-${index}`,
		index,
		title: `复制依据 ${index}`,
		snippet: `来源片段 ${index}，不属于回答正文。`,
		score: 0.8,
	}));
	await openAsk(page, [
		[
			meta(),
			frame("citations", citations),
			frame("token", answer),
			done(answer, undefined, undefined, citations, {
				trace_id: "copy-answer-fixture-trace",
			}),
		],
	]);
	await submit(page, "复制原始回答", 0);
	await release(page, 0, 3);
	const turn = page.locator("[data-turn-id]");
	await expect(turn.getByRole("article")).toContainText("保留格式");
	await expect(
		turn.getByRole("button", { name: /^(复制回答|已复制回答)$/ }),
	).toHaveCount(0);
	await release(page, 0, 1);
	await closeStream(page, 0);
	await expect(page.getByRole("textbox")).toBeEnabled();
	const copy = turn.getByRole("button", { name: "复制回答", exact: true });
	await expect(copy).toBeVisible();
	await expect(copy).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await copy.focus();
	await page.keyboard.press("Shift+Tab");
	await page.keyboard.press("Tab");
	await expect(copy).toBeFocused();
	// Base UI tooltips are visual labels; the trigger supplies the accessible name.
	await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(
		"复制回答",
	);
	await pause(page);
	await copy.press("Enter");
	await expect(
		turn.getByRole("button", { name: "已复制回答", exact: true }),
	).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		answer,
	);
	await page.clock.runFor(1000);
	await expect(
		turn.getByRole("button", { name: "已复制回答", exact: true }),
	).toBeVisible();
	await page.clock.runFor(600);
	await expect(copy).toBeVisible();
	await expect(
		turn.getByRole("button", { name: "已复制回答", exact: true }),
	).toHaveCount(0);
});

for (const terminal of ["cancelled", "error"] as const) {
	test(`answer copy retains raw partial Markdown after ${terminal}`, async ({
		page,
		context,
	}) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		const partial = "保留的 **部分回答**。[1]\n\n- 尚未完成的条目";
		const message = "已收到流式失败事件";
		await openAsk(page, [
			[
				meta(),
				frame("token", partial),
				...(terminal === "cancelled"
					? [frame("token", "STALE COPY CONTENT"), done("STALE COPY CONTENT")]
					: [frame("error", { message })]),
			],
		]);
		await submit(page, `复制部分回答 ${terminal}`, 0);
		await release(page, 0, 2);
		const turn = page.locator("[data-turn-id]");
		const article = turn.getByRole("article");
		await expect(article).toContainText("部分回答");
		await expect(
			turn.getByRole("button", { name: /^(复制回答|已复制回答)$/ }),
		).toHaveCount(0);
		if (terminal === "cancelled") {
			await page
				.getByRole("button", { name: "停止生成", exact: true })
				.last()
				.click();
			await release(page, 0, 2);
			await rejectStream(page, 0);
			await expect(article).not.toContainText("STALE COPY CONTENT");
		} else {
			await release(page, 0, 1);
			await closeStream(page, 0);
			await expect(article.getByRole("alert")).toContainText(
				"回答生成失败，请重试",
			);
		}
		await expect(page.getByRole("textbox")).toBeEnabled();
		await expect(
			turn.getByRole("button", { name: "重试", exact: true }),
		).toBeEnabled();
		await turn.getByRole("button", { name: "复制回答", exact: true }).click();
		await expect(
			turn.getByRole("button", { name: "已复制回答", exact: true }),
		).toBeVisible();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
			partial,
		);
	});
}

for (const failure of ["missing", "denied"] as const) {
	test(`answer copy reports ${failure} Clipboard API without claiming success`, async ({
		page,
	}) => {
		await page.addInitScript((mode) => {
			Object.defineProperty(navigator, "clipboard", {
				configurable: true,
				value:
					mode === "missing"
						? undefined
						: {
								writeText: async () => {
									throw new DOMException(
										"Fixture clipboard permission denied",
										"NotAllowedError",
									);
								},
							},
			});
		}, failure);
		await openAsk(page, [[meta(), done("复制失败测试正文")]]);
		await submit(page, `复制失败 ${failure}`, 0);
		await release(page, 0, 2);
		await closeStream(page, 0);
		const turn = page.locator("[data-turn-id]");
		const copy = turn.getByRole("button", {
			name: "复制回答",
			exact: true,
		});
		await copy.click();
		const errorToast = page.locator('[data-sonner-toast][data-type="error"]');
		await expect(errorToast).toBeVisible();
		await expect(errorToast).toContainText(/复制|剪贴板/);
		await expect(copy).toBeEnabled();
		await expect(
			turn.getByRole("button", { name: "已复制回答", exact: true }),
		).toHaveCount(0);
		await expect(
			page.locator('[data-sonner-toast][data-type="success"]'),
		).toHaveCount(0);
	});
}

test("answer copy ignores repeated clicks and discards feedback after switching libraries", async ({
	page,
}) => {
	await page.addInitScript(() => {
		window.__answerClipboardFixture = { writes: [], pending: [] };
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: (text: string) => {
					window.__answerClipboardFixture.writes.push(text);
					return new Promise<void>((resolve) => {
						window.__answerClipboardFixture.pending.push(resolve);
					});
				},
			},
		});
	});
	const answer = "异步复制的 **原始正文**。[1]";
	await openAsk(page, [[meta(), done(answer)]]);
	await submit(page, "异步复制防重", 0);
	await release(page, 0, 2);
	await closeStream(page, 0);
	const turn = page.locator("[data-turn-id]");
	const copy = turn.getByRole("button", { name: "复制回答", exact: true });
	await expect(copy).toBeVisible();
	await pause(page);
	await copy.evaluate((element) => {
		if (!(element instanceof HTMLButtonElement)) {
			throw new Error("answer copy control must be a button");
		}
		element.click();
		element.click();
		element.click();
	});
	try {
		expect(
			await page.evaluate(() => window.__answerClipboardFixture.writes),
		).toEqual([answer]);
		await expect(
			turn.getByRole("button", { name: "已复制回答", exact: true }),
		).toHaveCount(0);
	} finally {
		await page.evaluate(() => {
			for (const resolve of window.__answerClipboardFixture.pending.splice(0)) {
				resolve();
			}
		});
	}
	await expect(
		turn.getByRole("button", { name: "已复制回答", exact: true }),
	).toBeVisible();
	await page.clock.runFor(1600);
	await expect(copy).toBeEnabled();
	await copy.click();
	expect(
		await page.evaluate(() => window.__answerClipboardFixture.writes),
	).toEqual([answer, answer]);
	await page
		.getByRole("combobox", { name: "知识库", exact: true })
		.fill("Beta");
	await page.getByRole("option", { name: "Stream Beta" }).click();
	await page.evaluate(() => {
		for (const resolve of window.__answerClipboardFixture.pending.splice(0)) {
			resolve();
		}
	});
	await expect(
		page.getByRole("button", { name: "已复制回答", exact: true }),
	).toHaveCount(0);
	await expect(
		page.locator('[data-sonner-toast][data-type="success"]'),
	).toHaveCount(0);
});

test("answer copy feedback is isolated by turn including a completed refusal", async ({
	page,
	context,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const first = "第一轮 **独立回答**。\n\n仅属于第一轮。";
	const second = "现有资料不足。\n\n**无法确认该结论。**";
	await openAsk(page, [
		[meta(), done(first)],
		[
			meta(),
			frame("done", {
				question: "fixture refusal question",
				answer: second,
				session_id: "fixture-session",
				citations: [],
				mode: "llm",
				refused: true,
				refuse_reason: "weak_match",
				retrieval_debug: {},
			} satisfies ApiAskResponse),
		],
	]);
	await submit(page, "第一轮复制状态", 0);
	await release(page, 0, 2);
	await closeStream(page, 0);
	await submit(page, "第二轮复制状态", 1);
	await release(page, 1, 2);
	await closeStream(page, 1);
	const turns = page.locator("[data-turn-id]");
	await expect(turns).toHaveCount(2);
	const firstTurn = turns.nth(0);
	const secondTurn = turns.nth(1);
	await expect(
		firstTurn.getByRole("button", { name: "重试", exact: true }),
	).toHaveCount(0);
	await expect(
		secondTurn.getByRole("button", { name: "重试", exact: true }),
	).toBeEnabled();
	await pause(page);
	await firstTurn
		.getByRole("button", { name: "复制回答", exact: true })
		.click();
	await expect(
		firstTurn.getByRole("button", { name: "已复制回答", exact: true }),
	).toBeVisible();
	await expect(
		secondTurn.getByRole("button", { name: "复制回答", exact: true }),
	).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(first);
	await page.clock.runFor(1000);
	await secondTurn
		.getByRole("button", { name: "复制回答", exact: true })
		.click();
	await expect(
		secondTurn.getByRole("button", { name: "已复制回答", exact: true }),
	).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		second,
	);
	await expect(
		firstTurn.getByRole("button", { name: "已复制回答", exact: true }),
	).toBeVisible();
	await page.clock.runFor(600);
	await expect(
		firstTurn.getByRole("button", { name: "复制回答", exact: true }),
	).toBeVisible();
	await expect(
		secondTurn.getByRole("button", { name: "已复制回答", exact: true }),
	).toBeVisible();
	await page.clock.runFor(1000);
	await expect(
		secondTurn.getByRole("button", { name: "复制回答", exact: true }),
	).toBeVisible();
});

test("compact Ask composer keeps its default height and a 44px send and stop target", async ({
	page,
}) => {
	await openAsk(page, [
		[meta(), frame("token", "紧凑输入框测试回答"), done("紧凑输入框测试回答")],
	]);
	const input = page.getByRole("textbox");
	const composer = input.locator("..");
	const height = await composer.evaluate(
		(element) => element.getBoundingClientRect().height,
	);
	expect(height).toBeGreaterThanOrEqual(56);
	expect(height).toBeLessThanOrEqual(80);
	const send = page.getByRole("button", { name: "发送", exact: true });
	await expect(send).toHaveCSS("width", "44px");
	await expect(send).toHaveCSS("height", "44px");
	await submit(page, "紧凑输入框尺寸", 0);
	await release(page, 0, 2);
	const stop = page
		.getByRole("button", { name: "停止生成", exact: true })
		.last();
	await expect(stop).toBeEnabled();
	await expect(stop).toHaveCSS("width", "44px");
	await expect(stop).toHaveCSS("height", "44px");
	await stop.click();
	await expect(input).toBeEnabled();
	await closeStream(page, 0);
});

test("refusal actions and compact composer share readable themes across narrow and desktop layouts", async ({
	page,
}, info) => {
	test.setTimeout(90_000);
	await openAsk(page, [
		[
			meta(),
			frame("done", {
				question: "fixture presentation question",
				answer: "请补充你想在当前知识库中查询的主题、对象或时间范围。",
				session_id: "fixture-session",
				citations: [],
				mode: "llm",
				refused: true,
				retrieval_debug: { trace_id: "presentation-fixture-trace" },
			} satisfies ApiAskResponse),
		],
	]);
	await submit(page, "待核对的问题", 0);
	await release(page, 0, 2);
	await closeStream(page, 0);
	await expect(page.getByText("未能回答", { exact: true })).toBeVisible();
	await expect(
		page.getByText("本次未提供确定答案", { exact: true }),
	).toHaveCount(0);
	await expect(page.getByText("无可用引用来源", { exact: true })).toHaveCount(
		0,
	);
	const actions = page.getByRole("group", { name: "回答操作", exact: true });
	const input = page.getByRole("textbox");
	const composer = input.locator("..");
	const send = page.getByRole("button", { name: "发送", exact: true });
	await expect(actions.getByRole("button")).toHaveCount(3);
	for (const { label: theme } of COLOR_THEMES) {
		for (const mode of ["浅色", "深色"]) {
			await page.getByRole("button", { name: "外观设置", exact: true }).click();
			await selectAppearanceRadio(
				page.getByRole("radio", { name: theme, exact: true }),
			);
			await selectAppearanceRadio(
				page.getByRole("radio", { name: mode, exact: true }),
			);
			await page.keyboard.press("Escape");
			for (const width of [320, 390, 1440]) {
				await page.setViewportSize({ width, height: 900 });
				await expect
					.poll(() =>
						page.evaluate(
							() => document.documentElement.scrollWidth <= innerWidth + 1,
						),
					)
					.toBe(true);
				await expect
					.poll(() =>
						composer.evaluate((el) => el.getBoundingClientRect().height),
					)
					.toBeLessThanOrEqual(80);
				await page.mouse.move(0, 0);
				await expect(send).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
				for (const button of await actions.getByRole("button").all()) {
					await expect(button).toHaveCSS(
						"background-color",
						"rgba(0, 0, 0, 0)",
					);
					await expect(button).toHaveCSS("width", "44px");
					await expect(button).toHaveCSS("height", "44px");
				}
				await expect
					.poll(async () => {
						const box = await composer.boundingBox();
						const button = await send.boundingBox();
						return Boolean(
							box &&
								button &&
								button.x >= box.x &&
								button.y >= box.y &&
								button.x + button.width <= box.x + box.width + 1 &&
								button.y + button.height <= box.y + box.height + 1,
						);
					})
					.toBe(true);
				if (
					(theme === "Vercel" && mode === "浅色" && width !== 320) ||
					(theme === "Violet Bloom" && mode === "深色" && width === 1440)
				) {
					await page.screenshot({
						path: info.outputPath(`ask-polish-${theme}-${mode}-${width}.png`),
						fullPage: true,
					});
				}
			}
		}
	}
	await input.fill("多行正文\n".repeat(40));
	await expect
		.poll(() => input.evaluate((el) => el.getBoundingClientRect().height))
		.toBeLessThanOrEqual(200);
	await input.fill("");
	await page.setViewportSize({ width: 320, height: 900 });
	await page.evaluate(() => {
		document.documentElement.style.fontSize = "200%";
	});
	await expect
		.poll(() =>
			page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth + 1,
			),
		)
		.toBe(true);
});

test("unmocked initial Ask load has no hydration errors", async ({ page }) => {
	const data = Promise.all([
		page.waitForResponse(
			(response) => new URL(response.url()).pathname === "/api/rag/health",
		),
		page.waitForResponse(
			(response) => new URL(response.url()).pathname === "/api/libraries",
		),
	]);
	await gotoAsk(page);
	await data;
	await expect(
		page.getByRole("heading", { name: "智能问答", exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "展开引用来源面板", exact: true })
		.first()
		.click();
	await closeSources(page);
});

test("controlled high-frequency SSE batches by time/size and flushes done without text loss", async ({
	page,
}, testInfo) => {
	const tokens = ["Burst ", ...Array<string>(128).fill("中🚀"), " e\u0301"];
	const burst = tokens.join("");
	const large = " size bound".repeat(400);
	const answer = `${burst}${large} END`;
	await openAsk(page, [
		[
			meta("assigned-session", "assigned-thread"),
			...tokens.map((token) => frame("token", token)),
			frame("token", large),
			frame("token", " END"),
			done(answer, "assigned-session", "assigned-thread"),
		],
	]);
	await submit(page, "Timed fixture question", 0);
	await pause(page);
	const article = page.getByRole("article");
	await release(page, 0, tokens.length + 1);
	await page.clock.runFor(31);
	await expect(article.getByText(burst, { exact: true })).toHaveCount(0);
	await page.clock.runFor(1);
	await expect(article.getByText(burst, { exact: true })).toBeVisible();
	await expect(page.getByRole("textbox")).toBeDisabled();
	await page.clock.resume();
	const path = testInfo.outputPath("ask-stream.png");
	await page.screenshot({ path, fullPage: true });
	await testInfo.attach("controlled Ask streaming UI", {
		path,
		contentType: "image/png",
	});
	await pause(page);
	await release(page, 0, 1);
	await expect(
		article.getByText(`${burst}${large}`, { exact: true }),
	).toBeVisible();
	await release(page, 0, 2);
	await closeStream(page, 0);
	await expect(article.getByText(answer, { exact: true })).toBeVisible();
	await expect(page.getByRole("textbox")).toBeEnabled();
	await expect(
		page.getByRole("button", { name: "停止生成", exact: true }),
	).toHaveCount(0);
	await page.clock.resume();
});

test("stop flushes an unpainted tail and stale frames cannot restart the turn", async ({
	page,
}) => {
	await openAsk(page, [
		[
			meta(),
			frame("token", "Retained cancel tail"),
			frame("token", "STALE"),
			done("STALE"),
		],
	]);
	await submit(page, "Cancel fixture question", 0);
	await pause(page);
	await release(page, 0, 2);
	await expect(
		page.getByText("Retained cancel tail", { exact: true }),
	).toHaveCount(0);
	await page
		.getByRole("button", { name: "停止生成", exact: true })
		.first()
		.click({ force: true });
	await expect(
		page.getByText("Retained cancel tail", { exact: true }),
	).toBeVisible();
	await expect(page.getByText("已停止", { exact: true })).toBeVisible();
	await release(page, 0, 2);
	await rejectStream(page, 0);
	await page.clock.runFor(64);
	await expect(page.getByRole("article")).not.toContainText("STALE");
	await expect(page.getByRole("textbox")).toBeEnabled();
	await expect(
		page.getByRole("button", { name: "停止生成", exact: true }),
	).toHaveCount(0);
});

test("official message scrolling follows output but preserves manual reading and anchors a new turn", async ({
	page,
}, info) => {
	const first = Array.from(
		{ length: 90 },
		(_, i) => `证据段落 ${i + 1}：核对文档版本与来源。`,
	).join("\n\n");
	const tail = "\n\n后续补充的证据。".repeat(20);
	await openAsk(page, [
		[meta(), frame("token", first), frame("token", tail), done(first + tail)],
		[meta(), frame("token", "第二轮回答"), done("第二轮回答")],
	]);
	await submit(page, "滚动阅读测试", 0);
	await release(page, 0, 2);
	const viewport = page.getByRole("region", {
		name: "问答阅读区",
		exact: true,
	});
	await expect
		.poll(() =>
			viewport.evaluate(
				(el) => el.scrollHeight - el.clientHeight - el.scrollTop,
			),
		)
		.toBeLessThan(10);
	await viewport.hover();
	await page.mouse.wheel(0, -600);
	const latest = page.getByRole("button", {
		name: "回到最新回答",
		exact: true,
	});
	await expect(latest).toHaveAttribute("data-active", "true");
	const readingPosition = await viewport.evaluate((el) => el.scrollTop);
	await release(page, 0, 1);
	await expect(page.getByRole("article")).toContainText("后续补充的证据。");
	await expect
		.poll(() => viewport.evaluate((el) => el.scrollTop))
		.toBeLessThan(readingPosition + 5);
	await latest.click();
	await expect
		.poll(() =>
			viewport.evaluate(
				(el) => el.scrollHeight - el.clientHeight - el.scrollTop,
			),
		)
		.toBeLessThan(10);
	await release(page, 0, 1);
	await closeStream(page, 0);
	await expect(page.getByRole("textbox")).toBeEnabled();
	await viewport.hover();
	await page.mouse.wheel(0, -600);
	await expect(latest).toHaveAttribute("data-active", "true");
	await submit(page, "新问题应定位到新轮次", 1);
	await release(page, 1, 3);
	await closeStream(page, 1);
	const next = page.locator('[data-slot="message-scroller-item"]').last();
	await expect(next).toContainText("第二轮回答");
	await expect
		.poll(async () => {
			const bounds = await next.boundingBox();
			const view = await viewport.boundingBox();
			return bounds && view
				? Math.abs(bounds.y - view.y)
				: Number.POSITIVE_INFINITY;
		})
		.toBeLessThan(100);
	await page.screenshot({
		path: info.outputPath("official-message-scrolling.png"),
		fullPage: true,
	});
});

test("prompt input does not submit an IME composition and preserves Shift+Enter", async ({
	page,
}) => {
	const requests = await openAsk(page, [
		[meta(), done("输入法测试回答")],
		[meta(), frame("token", "键盘按钮测试"), done("键盘按钮测试")],
	]);
	const input = page.getByRole("textbox");
	await expect(input.locator("..")).toHaveCSS("opacity", "1");
	const addon = input.locator("..").locator('[data-slot="input-group-addon"]');
	const addonBounds = await addon.boundingBox();
	expect(addonBounds).not.toBeNull();
	await addon.click({ position: { x: (addonBounds?.width ?? 0) - 2, y: 8 } });
	await expect(input).toBeFocused();
	await input.fill("输入法组合中的文字");
	await input.dispatchEvent("keydown", {
		key: "Enter",
		code: "Enter",
		keyCode: 229,
		isComposing: true,
	});
	expect(requests).toHaveLength(0);
	await expect(input).toBeEnabled();
	await input.press("Shift+Enter");
	await expect(input).toHaveValue("输入法组合中的文字\n");
	expect(requests).toHaveLength(0);
	await input.press("Enter");
	await waitForStream(page, 0);
	await release(page, 0, 2);
	await closeStream(page, 0);
	await expect(page.getByRole("article")).toContainText("输入法测试回答");
	await expect(input).toBeEnabled();
	await input.fill("用键盘发送和停止");
	await page.getByRole("button", { name: "发送", exact: true }).press("Enter");
	await waitForStream(page, 1);
	await release(page, 1, 2);
	await page
		.getByRole("button", { name: "停止生成", exact: true })
		.last()
		.press("Enter");
	await expect(page.getByRole("article").last()).toContainText("键盘按钮测试");
	await expect(page.getByRole("article").last()).toContainText("生成已中止");
	await closeStream(page, 1);
	expect(requests).toHaveLength(2);
});

test("same-turn retry survives late old metadata, done, rejection, and finally", async ({
	page,
}) => {
	const requests = await openAsk(page, [
		[
			meta(),
			frame("token", "Old attempt"),
			meta("STALE-session", "STALE-thread"),
			frame("citations", []),
			frame("token", "STALE"),
			frame("error", { message: "STALE error" }),
			done("STALE"),
		],
		[
			meta("current-session", "current-thread"),
			frame("token", "Current retry"),
			done("Current retry", "current-session", "current-thread"),
		],
		[done("Followup safe", "current-session", "current-thread")],
	]);
	await submit(page, "Retry fixture question", 0);
	await release(page, 0, 2);
	await page
		.getByRole("button", { name: "停止生成", exact: true })
		.first()
		.click();
	await page.getByRole("button", { name: "重试", exact: true }).click();
	await waitForStream(page, 1);
	await closeSources(page);
	await release(page, 1, 2);
	await expect(page.getByText("Current retry", { exact: true })).toBeVisible();
	await release(page, 0, 5);
	await rejectStream(page, 0);
	await expect(page.getByRole("article")).toHaveCount(1);
	await expect(page.getByRole("article")).not.toContainText("STALE");
	await expect(page.getByRole("textbox")).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "停止生成", exact: true }).first(),
	).toBeVisible();
	await release(page, 1, 1);
	await closeStream(page, 1);
	await submit(page, "Followup fixture question", 2);
	expect(requests[2]).toMatchObject({
		session_id: "current-session",
		thread_id: "current-thread",
	});
	await release(page, 2, 1);
	await closeStream(page, 2);
	await expect(page.getByText("Followup safe", { exact: true })).toBeVisible();
	await expect(page.getByRole("article")).toHaveCount(2);
});

test("library switch starts a clean session and ignores old work", async ({
	page,
}) => {
	const requests = await openAsk(page, [
		[
			meta(),
			frame("token", "Alpha retained tail"),
			frame("token", "STALE"),
			done("STALE"),
		],
		[meta(), frame("token", "Beta answer"), done("Beta answer")],
	]);
	await submit(page, "Alpha fixture question", 0);
	await release(page, 0, 2);
	const chooser = page.getByRole("combobox", { name: "知识库", exact: true });
	await chooser.fill("Stream Beta");
	await page.getByRole("option", { name: "Stream Beta", exact: true }).click();
	await expect(chooser).toHaveValue("Stream Beta");
	await expect(
		page.getByText("Alpha retained tail", { exact: true }),
	).toHaveCount(0);
	await expect(page.getByRole("article")).toHaveCount(0);
	await expect(page.getByRole("textbox")).toBeEnabled();
	await release(page, 0, 2);
	await rejectStream(page, 0);
	await submit(page, "Beta fixture question", 1);
	expect(requests[1]).toMatchObject({ library_id: "stream-beta" });
	expect(requests[1]).not.toHaveProperty("session_id");
	expect(requests[1]).not.toHaveProperty("thread_id");
	await release(page, 1, 3);
	await closeStream(page, 1);
	await expect(page.getByText("Beta answer", { exact: true })).toBeVisible();
	await expect(page.getByRole("article")).toHaveCount(1);
	await expect(page.getByRole("article").first()).not.toContainText("STALE");
	await expect(page.getByRole("textbox")).toBeEnabled();
});

test("switching libraries in an archive leaves it intact and asks without the old thread", async ({
	page,
}) => {
	const requests = await openAsk(page, [
		[meta("fresh-session"), done("New library answer", "fresh-session")],
	]);
	await page.evaluate(() =>
		history.pushState(null, "", "/app/ask?thread=fixture-archive"),
	);
	await expect(
		page.getByText("Saved archive answer", { exact: true }),
	).toBeVisible();
	const chooser = page.getByRole("combobox", { name: "知识库", exact: true });
	await expect(chooser).toHaveValue("Stream Beta");
	await chooser.fill("Stream Alpha");
	await page.getByRole("option", { name: "Stream Alpha", exact: true }).click();
	await expect(page).toHaveURL(/\/app\/ask$/);
	await expect(page.getByRole("article")).toHaveCount(0);
	await submit(page, "New library question", 0);
	expect(requests[0]).toMatchObject({ library_id: "stream-alpha" });
	expect(requests[0]).not.toHaveProperty("thread_id");
	expect(requests[0]).not.toHaveProperty("session_id");
	await release(page, 0, 2);
	await closeStream(page, 0);
	await expect(
		page.getByText("New library answer", { exact: true }),
	).toBeVisible();
	await page.evaluate(() =>
		history.pushState(null, "", "/app/ask?thread=fixture-archive"),
	);
	await expect(
		page.getByText("Saved archive answer", { exact: true }),
	).toBeVisible();
	await expect(page.getByRole("article")).toHaveCount(1);
});

test("a delayed archive response cannot restore the previous library session", async ({
	page,
}) => {
	const requests = await openAsk(page, [
		[
			meta("old-session"),
			frame("token", "Old answer"),
			done("Old answer", "old-session"),
		],
		[meta("new-session"), done("New answer", "new-session")],
	]);
	let releaseArchive: (() => void) | undefined;
	const archiveReady = new Promise<void>((resolve) => {
		releaseArchive = resolve;
	});
	await page.route("**/api/rag/v1/threads", async (route) => {
		await archiveReady;
		await route.fulfill({ json: archivedThread });
	});
	await submit(page, "Old question", 0);
	await release(page, 0, 3);
	await closeStream(page, 0);
	await expect(page.getByRole("textbox")).toBeEnabled();
	const archiveRequest = page.waitForRequest(
		(request) =>
			new URL(request.url()).pathname === "/api/rag/v1/threads" &&
			request.method() === "POST",
	);
	await page.getByRole("button", { name: "归档当前会话", exact: true }).click();
	await archiveRequest;
	const chooser = page.getByRole("combobox", { name: "知识库", exact: true });
	await chooser.fill("Stream Beta");
	await page.getByRole("option", { name: "Stream Beta", exact: true }).click();
	const archiveResponse = page.waitForResponse(
		(response) => new URL(response.url()).pathname === "/api/rag/v1/threads",
	);
	releaseArchive?.();
	await archiveResponse;
	await expect(page.getByRole("article")).toHaveCount(0);
	await submit(page, "New question", 1);
	expect(requests[1]).toMatchObject({ library_id: "stream-beta" });
	expect(requests[1]).not.toHaveProperty("thread_id");
	expect(requests[1]).not.toHaveProperty("session_id");
	await release(page, 1, 2);
	await closeStream(page, 1);
	await expect(page).toHaveURL(/\/app\/ask$/);
	await expect(page.getByText("New answer", { exact: true })).toBeVisible();
});

test("URL thread switch hydrates archive and ignores old stream completion", async ({
	page,
}) => {
	const requests = await openAsk(page, [
		[
			meta(),
			frame("token", "Old temporary answer"),
			frame("token", "STALE"),
			done("STALE"),
		],
		[
			meta("archive-session", "fixture-archive"),
			frame("token", "Archive followup"),
			done("Archive followup", "archive-session", "fixture-archive"),
		],
	]);
	await submit(page, "Temporary fixture question", 0);
	await release(page, 0, 2);
	// Next integrates native history with useSearchParams; retain this mounted Ask UI.
	await page.evaluate(() =>
		history.pushState(null, "", "/app/ask?thread=fixture-archive"),
	);
	await expect(
		page.getByText("Saved archive answer", { exact: true }),
	).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => window.__askStreamFixtures[0].aborted))
		.toBe(true);
	await release(page, 0, 2);
	await rejectStream(page, 0);
	await expect(page.getByRole("article")).toHaveCount(1);
	await expect(page.getByRole("article")).not.toContainText("STALE");
	await submit(page, "Archive followup question", 1);
	expect(requests[1]).toMatchObject({
		library_id: "stream-beta",
		session_id: "archive-session",
		thread_id: "fixture-archive",
	});
	await release(page, 1, 2);
	await expect(
		page.getByText("Archive followup", { exact: true }),
	).toBeVisible();
	await expect(page.getByRole("textbox")).toBeDisabled();
	await release(page, 1, 1);
	await closeStream(page, 1);
	await expect(page.getByRole("textbox")).toBeEnabled();
	await expect(page.getByRole("article")).toHaveCount(2);
});

test("refreshed library inventory cannot move an archived stream to another library", async ({
	page,
}) => {
	const requests = await openAsk(page, [
		[
			meta("archive-session", "fixture-archive"),
			frame("token", "Partial archived answer"),
			done(
				"Unusable late archived answer",
				"archive-session",
				"fixture-archive",
			),
		],
	]);
	await page.evaluate(() =>
		history.pushState(null, "", "/app/ask?thread=fixture-archive"),
	);
	const chooser = page.getByRole("combobox", { name: "知识库", exact: true });
	await expect(chooser).toHaveValue("Stream Beta");
	await submit(page, "Archived stream refresh", 0);
	await release(page, 0, 2);
	await expect(
		page.getByText("Partial archived answer", { exact: true }),
	).toBeVisible();
	expect(requests[0]).toMatchObject({
		library_id: "stream-beta",
		thread_id: "fixture-archive",
	});

	let inventory: ApiLibrary[] = [
		libraries[0],
		{ ...libraries[1], status: "indexing", ready_count: 0 },
	];
	await page.route("**/api/libraries", (route) =>
		route.fulfill({ json: inventory }),
	);
	async function refreshInventory() {
		await page.clock.fastForward(16_000);
		const response = page.waitForResponse(
			(item) => new URL(item.url()).pathname === "/api/libraries",
		);
		await page.evaluate(() =>
			window.dispatchEvent(new Event("visibilitychange")),
		);
		await response;
	}
	await refreshInventory();
	await expect(chooser).toHaveValue("Stream Beta · 索引中");
	expect(await page.evaluate(() => window.__askStreamFixtures[0].aborted)).toBe(
		false,
	);

	inventory = [libraries[0]];
	await refreshInventory();
	await expect(chooser).not.toHaveValue("Stream Alpha");
	await expect(page.getByRole("textbox")).toBeDisabled();
	await expect
		.poll(() => page.evaluate(() => window.__askStreamFixtures[0].aborted))
		.toBe(true);
	await release(page, 0, 1);
	await rejectStream(page, 0);
	await expect(
		page.getByText("Unusable late archived answer", { exact: true }),
	).toHaveCount(0);
	expect(requests).toHaveLength(1);
});

test("switching to a failed thread clears the old answer and source drawer before the response", async ({
	page,
}) => {
	const answer = "Previous thread answer with a source.";
	await openAsk(page, []);
	await page.route("**/api/rag/v1/threads/fixture-archive/continue", (route) =>
		route.fulfill({
			json: {
				...archivedThread,
				turns: [
					{ ...archivedThread.turns[0], answer, citations: [previewCitation] },
				],
			},
		}),
	);
	let respond = () => {};
	const gate = new Promise<void>((resolve) => {
		respond = resolve;
	});
	await page.route(
		"**/api/rag/v1/threads/unavailable/continue",
		async (route) => {
			await gate;
			await route.fulfill({
				status: 404,
				json: { detail: "thread not found" },
			});
		},
	);
	try {
		await page.evaluate(() =>
			history.pushState(null, "", "/app/ask?thread=fixture-archive"),
		);
		await expect(page.getByText(answer, { exact: true })).toBeVisible();
		const sources = await expandAnswerSources(page.getByRole("article"), 1);
		await sources.locator("[data-citation-id]").first().click();
		const preview = page.getByText(previewCitation.text ?? "", { exact: true });
		await expect(preview).toBeVisible();

		const recovery = page.waitForRequest(
			"**/api/rag/v1/threads/unavailable/continue",
		);
		await page.evaluate(() =>
			history.pushState(null, "", "/app/ask?thread=unavailable"),
		);
		await recovery;
		await expect(page.getByRole("article")).toHaveCount(0);
		await expect(preview).toHaveCount(0);
		await expect(
			page.getByRole("dialog", { name: "引用来源", exact: true }),
		).toBeHidden();
		await expect(
			page.getByRole("complementary", { name: "引用来源", exact: true }),
		).toHaveCount(0);
		await expect(page.getByRole("textbox")).toBeDisabled();
		respond();
		await expect(
			page.getByText("无法打开归档会话，请从会话历史重试。", { exact: true }),
		).toBeVisible();
		await expect(page.getByRole("article")).toHaveCount(0);
		await expect(page.getByRole("textbox")).toBeDisabled();
	} finally {
		respond();
	}
});

for (const archiveFails of [false, true]) {
	test(`archive pending blocks new questions and retries until ${archiveFails ? "failure" : "hydration"}`, async ({
		page,
	}) => {
		const requests = await openAsk(page, [
			[meta(), frame("token", "Partial answer")],
			[
				done(
					"Safe next answer",
					"archive-session",
					archiveFails ? undefined : "fixture-archive",
				),
			],
		]);
		let releaseArchive = () => {};
		let releaseHydration = () => {};
		const archiveGate = new Promise<void>((resolve) => {
			releaseArchive = resolve;
		});
		const hydrationGate = new Promise<void>((resolve) => {
			releaseHydration = resolve;
		});
		const detail = { ...archivedThread, library_id: "stream-alpha" };
		await page.route("**/api/rag/v1/threads", async (route) => {
			await archiveGate;
			await route.fulfill({
				status: archiveFails ? 503 : 200,
				json: archiveFails ? { detail: "Archive unavailable" } : detail,
			});
		});
		await page.route("**/api/rag/v1/threads/*/continue", async (route) => {
			await hydrationGate;
			await route.fulfill({ json: detail });
		});
		try {
			await submit(page, "Archive pending question", 0);
			await release(page, 0, 2);
			await page
				.getByRole("button", { name: "停止生成", exact: true })
				.first()
				.click();
			await expect(
				page.getByRole("button", { name: "重试", exact: true }),
			).toBeEnabled();
			await page.getByRole("textbox").fill("Draft next question");
			const archiveRequest = page.waitForRequest("**/api/rag/v1/threads");
			await page
				.getByRole("button", { name: "归档当前会话", exact: true })
				.click();
			await archiveRequest;
			await expect(page.getByRole("textbox")).toBeDisabled();
			await expect(
				page.getByRole("button", { name: "发送", exact: true }),
			).toBeDisabled();
			await expect(
				page.getByRole("button", { name: "重试", exact: true }),
			).toBeDisabled();
			// Dispatch directly to exercise the handler guard as well as disabled controls.
			await page
				.getByRole("textbox")
				.dispatchEvent("keydown", { key: "Enter" });
			await page
				.getByRole("button", { name: "重试", exact: true })
				.dispatchEvent("click");
			expect(requests).toHaveLength(1);
			if (archiveFails) {
				releaseArchive();
				await expect(
					page.getByText("Archive unavailable", { exact: true }),
				).toBeVisible();
				await expect(
					page.getByRole("button", { name: "重试", exact: true }),
				).toBeEnabled();
			} else {
				const hydrationRequest = page.waitForRequest(
					"**/api/rag/v1/threads/*/continue",
				);
				releaseArchive();
				await hydrationRequest;
				await expect(page.getByRole("textbox")).toBeDisabled();
				await expect(
					page.getByRole("button", { name: "重试", exact: true }),
				).toBeDisabled();
				releaseHydration();
				await expect(
					page.getByText("Saved archive answer", { exact: true }),
				).toBeVisible();
			}
			await expect(page.getByRole("textbox")).toBeEnabled();
			await expect(page.getByRole("textbox")).toHaveValue(
				"Draft next question",
			);
			await submit(page, "Next question after archive", 1);
			if (!archiveFails) {
				expect(requests[1]).toMatchObject({
					thread_id: "fixture-archive",
					session_id: "archive-session",
				});
			} else {
				expect(requests[1]).not.toHaveProperty("thread_id");
			}
			await release(page, 1, 1);
			await closeStream(page, 1);
			await expect(
				page.getByText("Safe next answer", { exact: true }),
			).toBeVisible();
			await expect(page.getByRole("article")).toHaveCount(2);
		} finally {
			releaseArchive();
			releaseHydration();
		}
	});
}
