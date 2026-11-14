/**
 * Run from the repository root:
 *   pnpm exec tsx scripts/capture-product-visuals.ts
 * Only overwrites the four public/product-*.png files listed below.
 * Uses the existing local server; never starts a server or saves authentication.
 * All business data and diagnostics are synthetic examples, not benchmarks.
 */
import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseEnv } from "node:util";
import { chromium, expect, type Locator, type Page } from "@playwright/test";
import type { ModelUsageSummary } from "../src/core/ai/model-usage";
import type { ApiDocument, ApiHealth, ApiLibrary } from "../src/lib/api";
import type { OperationsEventDetail } from "../src/lib/operations-event-detail";

const BASE_URL = "http://127.0.0.1:3001";
const STAMP = "2026-11-13T02:00:00.000Z";
const LIBRARY_ID = "b1000000-0000-4000-8000-000000000001";
const EVENT_ID = "a1000000-0000-4000-8000-000000000001";
const REQUEST_ID = "a2000000-0000-4000-8000-000000000001";
const OUTPUTS = [
	"public/product-library-workbench.png",
	"public/product-library-workbench-dark.png",
	"public/product-request-trace.png",
	"public/product-request-trace-dark.png",
] as const;
type Output = (typeof OUTPUTS)[number];

// Privacy-only capture styles: no product layout, typography or colors are changed.
const CAPTURE_STYLE = `
  [data-slot="sidebar-footer"], nextjs-portal { visibility: hidden !important; }
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
  }
`;

const documentExamples = [
	{ name: "员工手册.md", size: 48_128, chunks: 42 },
	{ name: "报销制度.pdf", size: 286_720, chunks: 28 },
	{ name: "考勤与休假.md", size: 24_576, chunks: 21 },
	{ name: "信息安全规范.pdf", size: 196_608, chunks: 36 },
	{ name: "差旅管理办法.pdf", size: 327_680, chunks: 0 },
	{ name: "办公设备申领.md", size: 12_288, chunks: 0 },
];

const documents: ApiDocument[] = documentExamples.map((example, index) => ({
	id: `b2000000-0000-4000-8000-00000000000${index + 1}`,
	library_id: LIBRARY_ID,
	name: example.name,
	filename: example.name,
	content_type: example.name.endsWith(".md")
		? "text/markdown"
		: "application/pdf",
	status: index === 4 ? "processing" : index === 5 ? "failed" : "ready",
	chunk_count: example.chunks,
	size_bytes: example.size,
	has_file: true,
	error: index === 5 ? "示例：解析任务失败，等待人工重试。" : null,
	job_id: `b3000000-0000-4000-8000-00000000000${index + 1}`,
	job_status: index === 4 ? "running" : index === 5 ? "failed" : "completed",
	job_stage: index === 4 ? "embedding" : index === 5 ? "parse" : "done",
	job_progress: index === 4 ? 64 : index === 5 ? 0 : 100,
	created_at: "2026-11-12T01:00:00.000Z",
	updated_at: STAMP,
}));

const libraries: ApiLibrary[] = [
	{
		id: LIBRARY_ID,
		name: "公司制度",
		description: "员工手册、财务报销与日常办公制度 · 示例资料",
		status: "indexing",
		doc_count: documents.length,
		ready_count: 4,
		document_profile: "regulatory",
		applied_document_profile: "regulatory",
		parse_preference: "local_only",
		requires_reindex: false,
		created_at: STAMP,
		updated_at: STAMP,
	},
	...[
		{ name: "产品文档", id: "b1000000-0000-4000-8000-000000000002" },
		{ name: "运维手册", id: "b1000000-0000-4000-8000-000000000003" },
	].map((item) => ({
		...item,
		description: "示例资料",
		status: "empty",
		doc_count: 0,
		ready_count: 0,
		created_at: STAMP,
		updated_at: STAMP,
	})),
];

// Same public contracts as operations-requests.spec.ts; no real run is executed.
const modelUsage: ModelUsageSummary = {
	version: 1,
	status: "reported",
	truncated: false,
	inputTokens: 3_200,
	outputTokens: 400,
	totalTokens: 3_600,
	cachedInputTokens: 800,
	calls: [
		{
			stage: "judge",
			model: "example-judge",
			provider: "example-provider",
			attempt: 1,
			status: "completed",
			usageStatus: "reported",
			inputTokens: 1_200,
			outputTokens: 100,
			totalTokens: 1_300,
			cachedInputTokens: 300,
		},
		{
			stage: "generate",
			model: "example-chat",
			provider: "example-provider",
			attempt: 1,
			status: "completed",
			usageStatus: "reported",
			inputTokens: 2_000,
			outputTokens: 300,
			totalTokens: 2_300,
			cachedInputTokens: 500,
		},
	],
};

const trace: OperationsEventDetail = {
	source: "ask",
	id: EVENT_ID,
	request_id: REQUEST_ID,
	status: "completed",
	error_code: null,
	guidance: { title: "示例请求", cause: "", recovery: "" },
	otel_trace_id: null,
	workflow_id: null,
	library_id: LIBRARY_ID,
	document_id: null,
	document_version_id: null,
	query_type: "fact",
	retrieval_mode: "hybrid",
	started_at: STAMP,
	ended_at: "2026-11-13T02:00:08.000Z",
	latency_ms: 8_000,
	message: null,
	ask: {
		refuse_reason: null,
		citation_count: 2,
		used_hybrid: true,
		used_rerank: true,
		model_usage: modelUsage,
	},
	stages: [
		{ stage: "retrieve", duration: 800 },
		{ stage: "judge", duration: 2_000 },
		{ stage: "generate", duration: 5_000 },
	].map(({ stage, duration }, index) => ({
		id: `${EVENT_ID}-${stage}`,
		sequence: index + 1,
		attempt: null,
		stage,
		outcome: "completed",
		error_code: null,
		started_at: null,
		ended_at: null,
		duration_ms: duration,
	})),
};

class CaptureError extends Error {}
let phase = "startup";

async function setAppearance(page: Page, mode: "light" | "dark") {
	phase = `${mode} open appearance control`;
	await page.getByRole("button", { name: "外观设置", exact: true }).click();
	const appearance = page.getByRole("dialog", { name: "外观", exact: true });
	phase = `${mode} select Vercel theme`;
	await appearance.getByRole("radio", { name: "Vercel", exact: true }).check();
	phase = `${mode} select radius 4`;
	await appearance.getByRole("spinbutton", { name: "圆角数值", exact: true }).fill("4");
	await page.keyboard.press("Tab");
	phase = `${mode} select color scheme`;
	await appearance
		.getByRole("radio", { name: mode === "light" ? "浅色" : "深色", exact: true })
		.check();
	await expect(page.locator("html")).toHaveAttribute(
		"data-color-theme",
		"vercel",
	);
	await expect(page.locator("html")).toHaveAttribute("data-radius", "4");
	if (mode === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
	else await expect(page.locator("html")).not.toHaveClass(/dark/);
	await page.keyboard.press("Escape");
	await expect(appearance).toHaveCount(0);
}

async function settle(page: Page) {
	const capturePhase = phase;
	await page.mouse.move(0, 0);
	phase = `${capturePhase}: fonts`;
	await page.evaluate(() => document.fonts.ready);
	phase = `${capturePhase}: images`;
	await page.waitForFunction(() =>
		Array.from(document.images).every(
			(img) => img.complete && img.naturalWidth > 0,
		),
	);
	phase = `${capturePhase}: stop motion`;
	await page.evaluate(async () => {
		if (document.activeElement instanceof HTMLElement)
			document.activeElement.blur();
		for (const animation of document.getAnimations()) animation.cancel();
		await new Promise<void>((done) =>
			requestAnimationFrame(() => requestAnimationFrame(() => done())),
		);
	});
	phase = `${capturePhase}: no visible alerts`;
	await expect(
		page.locator('[role="alert"]:not(#__next-route-announcer__)'),
	).toHaveCount(0);
	phase = `${capturePhase}: viewport fit`;
	await expect
		.poll(() =>
			page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
		)
		.toBe(true);
	phase = capturePhase;
}

async function screenshot(page: Page, target?: Locator) {
	await settle(page);
	return (target ?? page).screenshot({
		animations: "disabled",
		caret: "hide",
		style: CAPTURE_STYLE,
		scale: "css",
	});
}

async function main() {
	const root = await realpath(process.cwd());
	if (root !== (await realpath(resolve(dirname(process.argv[1]), "..")))) {
		throw new CaptureError("Run this script from the UnoRAG repository root.");
	}
	console.log(
		"Run from repository root: pnpm exec tsx scripts/capture-product-visuals.ts",
	);
	console.log(
		"Only these four images will be overwritten (no other output files):",
	);
	for (const output of OUTPUTS) console.log(`  ${output}`);
	console.log(
		"Synthetic examples only; timings and Token counts are not benchmarks.",
	);

	phase = "read bootstrap credentials";
	const bootstrap = parseEnv(
		await readFile(resolve(root, "deploy/config/bootstrap.env"), "utf8"),
	);
	const email = bootstrap.UNORAG_ADMIN_EMAIL?.trim();
	const password = bootstrap.UNORAG_ADMIN_PASSWORD;
	if (!email || !password)
		throw new CaptureError("Bootstrap credentials are missing.");
	const metadata = JSON.parse(
		await readFile(resolve(root, "package.json"), "utf8"),
	) as { version: string };
	const release = {
		version: `${metadata.version}-dev`,
		channel: "development" as const,
		revision: "development",
		revision_short: "development",
		built_at: null,
		image_digest: null,
		dbos_application_version: null,
	};
	const health: ApiHealth = {
		status: "ok",
		service: "unorag",
		env: "development",
		release,
		ask_mode: "native",
		effective_mode: "native",
		graph: "native",
		degraded: false,
		has_llm_key: true,
		qdrant_ok: true,
		live_ready: true,
		ask_ready: true,
		reasons: [],
		metadata_backend: "postgres",
		metadata_ok: true,
	};
	const requestRow = {
		id: EVENT_ID,
		request_id: REQUEST_ID,
		started_at: trace.started_at,
		ended_at: trace.ended_at,
		status: trace.status,
		query_type: trace.query_type,
		retrieval_mode: trace.retrieval_mode,
		latency_ms: trace.latency_ms,
		citation_count: 2,
		library_id: LIBRARY_ID,
	};
	const operations = {
		release,
		scope: { workspace_id: "example-workspace" },
		overall: { status: "healthy", evaluated_at: STAMP, stale: false },
		notifications: { webhook: false, email: false },
		generated_at: STAMP,
		window: {
			from: "2026-11-12T02:00:00.000Z",
			to: STAMP,
			hours: 24,
			stuck_after_minutes: 30,
		},
		ask: {
			total: 1,
			completed: 1,
			refused: 0,
			failed: 0,
			cancelled: 0,
			running: 0,
			latency_ms: { p50: 8_000, p95: 8_000 },
			stage_latency_ms: [],
			without_citations: 0,
		},
		jobs: {
			queued: 0,
			running: 1,
			delete_failed: 0,
			dead: 0,
			stuck: 0,
			oldest_active: null,
			stage_latency_ms: [],
		},
		components: [],
		alerts: [],
		recent_errors: [],
	};
	const fixtures = new Map<string, unknown>([
		["/api/libraries", libraries],
		...libraries.map((library): [string, unknown] => [
			`/api/libraries/${library.id}/documents`,
			library.id === LIBRARY_ID ? documents : [],
		]),
		["/api/rag/health", health],
		["/api/workspaces", { items: [], can_create: false }],
		["/api/workspace/operations", operations],
		[
			"/api/workspace/operations/requests",
			{
				items: [requestRow],
				next_cursor: null,
				window: operations.window,
			},
		],
		[`/api/workspace/operations/events/ask/${EVENT_ID}`, trace],
	]);

	phase = "launch Chromium";
	const browser = await chromium.launch();
	try {
		const context = await browser.newContext({
			baseURL: BASE_URL,
			viewport: { width: 1440, height: 900 },
			deviceScaleFactor: 1,
			locale: "zh-CN",
			timezoneId: "Asia/Shanghai",
			colorScheme: "light",
			reducedMotion: "reduce",
			serviceWorkers: "block",
		});
		phase = "real API sign-in";
		// API errors may contain request headers: never print the underlying error.
		let status: number;
		try {
			const login = await context.request.post("/api/auth/session", {
				data: { email, password },
				timeout: 30_000,
			});
			status = login.status();
			await login.dispose();
		} catch {
			throw new CaptureError(
				"Local API sign-in could not complete; credentials were not logged.",
			);
		}
		if (status !== 200)
			throw new CaptureError(
				`Local API sign-in returned HTTP ${status}; no automatic login retries.`,
			);
		console.log(
			"Real API sign-in succeeded; business API traffic is now fixture-only.",
		);

		const violations = new Set<string>();
		const pageErrors: string[] = [];
		await context.route("**/*", async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			if (url.origin !== BASE_URL) {
				violations.add("external network request");
				return route.abort("blockedbyclient");
			}
			if (url.pathname.startsWith("/api/")) {
				if (request.method() !== "GET" || !fixtures.has(url.pathname)) {
					violations.add(`${request.method()} ${url.pathname}`);
					return route.fulfill({
						status: 403,
						json: { detail: "Capture is read-only and fixture-only." },
					});
				}
				return route.fulfill({ json: fixtures.get(url.pathname) });
			}
			if (request.method() !== "GET") {
				violations.add("non-GET application request");
				return route.abort("blockedbyclient");
			}
			return route.continue();
		});
		const page = await context.newPage();
		page.setDefaultTimeout(30_000);
		page.on("pageerror", () => pageErrors.push("browser runtime error"));
		await page.clock.setFixedTime(new Date(STAMP));
		const captures = new Map<Output, Buffer>();
		for (const mode of ["light", "dark"] as const) {
			phase = `${mode} library navigation`;
			await page.goto("/app/libraries", { waitUntil: "networkidle" });
			if (!new URL(page.url()).pathname.startsWith("/app/")) {
				throw new CaptureError(
					"Session requires user action; no password/account changes were attempted.",
				);
			}
			await page.addStyleTag({ content: CAPTURE_STYLE });
			await setAppearance(page, mode);
			phase = `${mode} library heading`;
			await expect(
				page.getByRole("heading", { name: "公司制度", exact: true }),
			).toBeVisible();
			for (const doc of documents) {
				phase = `${mode} document visibility: ${doc.filename}`;
				await expect(
					page.getByRole("button", { name: doc.name, exact: true }),
				).toBeInViewport({ ratio: 1 });
			}
			phase = `${mode} library health`;
			await expect(
				page.getByText("知识服务在线", { exact: true }),
			).toBeVisible();
			phase = `${mode} library radius`;
			const radius = await page.evaluate(() => {
				const probe = document.createElement("i");
				probe.style.borderRadius = "var(--radius)";
				document.body.append(probe);
				const pixels = Number.parseFloat(
					getComputedStyle(probe).borderTopLeftRadius,
				);
				probe.remove();
				return pixels;
			});
			if (radius !== 4)
				throw new CaptureError(
					`Expected the existing 4px radius preset; measured ${radius}px.`,
				);
			phase = `${mode} library screenshot`;
			captures.set(
				mode === "light" ? OUTPUTS[0] : OUTPUTS[1],
				await screenshot(page),
			);

			phase = `${mode} request dialog`;
			await page.goto("/app/operations", { waitUntil: "networkidle" });
			await page.addStyleTag({ content: CAPTURE_STYLE });
			await page.getByRole("checkbox", { name: "30s 自动刷新" }).uncheck();
			await page.getByRole("button", { name: "请求记录", exact: true }).click();
			await page
				.getByRole("button", { name: `查看请求 ${REQUEST_ID}`, exact: true })
				.click();
			const dialog = page.getByRole("dialog", {
				name: "请求链路",
				exact: true,
			});
			await expect(dialog.getByText("知识检索", { exact: true })).toBeVisible();
			await expect(dialog.getByText("证据判断", { exact: true })).toBeVisible();
			await expect(dialog.getByText("答案生成", { exact: true })).toBeVisible();
			await expect(
				dialog
					.getByRole("region", { name: "模型 Token 用量" })
					.locator("dl")
					.first()
					.locator("dd"),
			).toHaveText(["3,200", "400", "3,600"]);
			await expect(dialog).toBeInViewport({ ratio: 1 });
			// Scroll only the existing top padding out of view, not any outcome text.
			const scrollport = dialog.locator("div.overflow-y-auto").first();
			const outcome = dialog.locator("section").first();
			const portBox = await scrollport.boundingBox();
			const outcomeBox = await outcome.boundingBox();
			if (!portBox || !outcomeBox)
				throw new CaptureError("Dialog scroll geometry is unavailable.");
			await scrollport.evaluate(
				(element, pixels) => {
					element.scrollTop = pixels;
				},
				Math.max(0, outcomeBox.y - portBox.y),
			);
			await expect(outcome).toBeInViewport({ ratio: 1 });
			const lastCallCounts = dialog
				.getByRole("listitem")
				.last()
				.locator("dl")
				.last()
				.locator("dd");
			for (const value of await lastCallCounts.all())
				await expect(value).toBeInViewport({ ratio: 1 });
			phase = `${mode} dialog screenshot`;
			captures.set(
				mode === "light" ? OUTPUTS[2] : OUTPUTS[3],
				await screenshot(page, dialog),
			);
			await page.keyboard.press("Escape");
		}
		if (violations.size) {
			throw new CaptureError(
				`Blocked unexpected traffic: ${[...violations].join(", ")}`,
			);
		}
		if (pageErrors.length)
			throw new CaptureError(
				"Browser runtime errors occurred; wait for HMR to settle and rerun.",
			);
		phase = "write four images";
		for (const output of OUTPUTS) {
			const buffer = captures.get(output);
			if (!buffer || buffer.length < 10_000)
				throw new CaptureError("Capture buffer is unexpectedly small.");
			const expectedWidth = output.includes("workbench") ? 1440 : 640;
			if (
				buffer.readUInt32BE(16) !== expectedWidth ||
				buffer.readUInt32BE(20) !== 900
			) {
				throw new CaptureError(`Unexpected raw PNG dimensions for ${output}.`);
			}
		}
		for (const output of OUTPUTS) {
			await writeFile(resolve(root, output), captures.get(output) as Buffer);
			console.log(`Wrote ${output}`);
		}
		console.log(
			"Completed: four screenshots, zero business writes, zero LLM calls, no saved cookies.",
		);
		await context.close();
	} finally {
		await browser.close();
	}
}

void main().catch((error: unknown) => {
	// Do not expose Playwright request logs, credentials, headers or page contents.
	console.error(`Capture failed during: ${phase}.`);
	console.error(
		error instanceof CaptureError
			? error.message
			: "Verification failed. Check the live components and rerun after HMR is stable.",
	);
	process.exitCode = 1;
});
