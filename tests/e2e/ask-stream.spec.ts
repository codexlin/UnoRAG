import { type Cookie, expect, type Page, test } from "@playwright/test";

import type {
	ApiAskResponse,
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

function done(answer: string, session = "fixture-session", thread?: string) {
	return frame("done", {
		question: "fixture question",
		answer,
		session_id: session,
		thread_id: thread,
		citations: [],
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
