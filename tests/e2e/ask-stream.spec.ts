import { type Cookie, expect, type Page, test } from "@playwright/test";

import type {
	ApiAskResponse,
	ApiCitation,
	ApiDocument,
	ApiHealth,
	ApiLibrary,
	ApiThreadDetail,
} from "../../src/lib/api";

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
) {
	return frame("done", {
		question: "fixture question",
		answer,
		session_id: session,
		thread_id: thread,
		citations,
		mode: "llm",
		refused: false,
		retrieval_debug: {},
		persisted: Boolean(thread),
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
	await page
		.getByRole("button", { name: "收起引用来源面板", exact: true })
		.last()
		.click();
	await expect(page.getByRole("dialog", { name: "证据轨道" })).toBeHidden();
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

async function rejectOld(page: Page, index: number) {
	await page.evaluate(
		(i) =>
			window.__askStreamFixtures[i].controller.error(
				new Error("delayed old transport rejection"),
			),
		index,
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
	await article.getByRole("button", { name: "1", exact: true }).click();
	const panel = testInfo.project.use.isMobile
		? page.getByRole("dialog", { name: "证据轨道" })
		: page.locator('aside[aria-hidden="false"]');
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
		expect(
			await block.evaluate((element) => {
				const bounds = element.getBoundingClientRect();
				return (
					element.scrollWidth > element.clientWidth &&
					getComputedStyle(element).overflowX === "auto" &&
					bounds.right <= window.innerWidth + 1
				);
			}),
		).toBe(true);
		await block.evaluate((element) => {
			element.scrollLeft = element.scrollWidth;
		});
		expect(
			await block.evaluate((element) => element.scrollLeft),
		).toBeGreaterThan(0);
		await article
			.getByRole("button", { name: /^(复制|已复制)$/ })
			.nth(index)
			.click();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
			snippet,
		);
	}
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
	await expect(page.getByText("已取消", { exact: true })).toBeVisible();
	await release(page, 0, 2);
	await rejectOld(page, 0);
	await page.clock.runFor(64);
	await expect(page.getByRole("article")).not.toContainText("STALE");
	await expect(page.getByRole("textbox")).toBeEnabled();
	await expect(
		page.getByRole("button", { name: "停止生成", exact: true }),
	).toHaveCount(0);
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
	await rejectOld(page, 0);
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
	await rejectOld(page, 0);
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
	await rejectOld(page, 0);
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
