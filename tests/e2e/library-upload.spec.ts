import { type Cookie, expect, type Page, test } from "@playwright/test";
import type {
	ApiDocument,
	ApiLibrary,
	ApiUploadResponse,
} from "../../src/lib/api";

const stamp = "2026-01-01T00:00:00.000Z";
let cookies: Cookie[] = [];
const libraries: ApiLibrary[] = ["Upload target", "Other library"].map(
	(name, index) => ({
		id: `upload-library-${index}`,
		name,
		status: "ready",
		doc_count: 1,
		ready_count: 1,
		created_at: stamp,
		updated_at: stamp,
	}),
);

type UploadPlan = {
	status: "accepted" | "ready" | number;
	error?: string;
	wait?: Promise<void>;
	listed?: boolean;
};

function deferred() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

async function selectLibrary(
	page: Page,
	isMobile: boolean,
	library: ApiLibrary,
) {
	if (isMobile) {
		const picker = page.getByRole("combobox", {
			name: "当前知识库",
			exact: true,
		});
		await picker.fill(library.name);
		await page.getByRole("option", { name: library.name, exact: true }).click();
		await expect(picker).toHaveValue(library.name);
	} else {
		await page
			.getByRole("complementary", { name: "知识库导航" })
			.getByRole("button", { name: new RegExp(library.name) })
			.click();
		await expect(page.getByRole("heading", { level: 3 })).toContainText(
			library.name,
		);
	}
}

async function installUploads(page: Page, plans: Record<string, UploadPlan>) {
	const documents = new Map(
		libraries.map((library) => [
			library.id,
			[
				{
					id: `existing-${library.id}`,
					library_id: library.id,
					name: `Existing ${library.name}`,
					filename: "existing.txt",
					content_type: "text/plain",
					status: "ready",
					chunk_count: 1,
					created_at: stamp,
					updated_at: stamp,
				},
			] as ApiDocument[],
		]),
	);
	const reads: string[] = [];
	const submissions: { libraryId: string; filename: string }[] = [];
	const cancelRequests: string[] = [];
	page.on("request", (request) => {
		if (/\/api\/jobs\/[^/]+\/cancel$/.test(new URL(request.url()).pathname))
			cancelRequests.push(request.url());
	});
	await page.route("**/api/libraries", (route) =>
		route.fulfill({
			json: libraries.map((library) => ({
				...library,
				status: documents
					.get(library.id)
					?.some((doc) => doc.status === "processing")
					? "indexing"
					: "ready",
			})),
		}),
	);
	await page.route("**/api/libraries/*/documents/*/versions", (route) =>
		route.fulfill({ json: [] }),
	);
	await page.route("**/api/libraries/*/documents", async (route) => {
		const request = route.request();
		const libraryId = new URL(request.url()).pathname.split("/")[3];
		if (request.method() === "GET") {
			reads.push(libraryId);
			await route.fulfill({ json: documents.get(libraryId) ?? [] });
			return;
		}
		const form = await new Response(
			new Uint8Array(request.postDataBuffer() ?? []),
			{
				headers: { "Content-Type": request.headers()["content-type"] },
			},
		).formData();
		const file = form.get("file");
		if (!(file instanceof File))
			throw new Error("Expected a real multipart file upload");
		submissions.push({ libraryId, filename: file.name });
		const plan = plans[file.name];
		if (!plan) throw new Error(`Unexpected upload: ${file.name}`);
		await plan.wait;
		if (typeof plan.status === "number") {
			await route.fulfill({
				status: plan.status,
				json: { detail: plan.error },
			});
			return;
		}
		const doc: ApiDocument = {
			id: `uploaded-${file.name}`,
			library_id: libraryId,
			name: file.name,
			filename: file.name,
			content_type: "text/plain",
			status: plan.status === "ready" ? "ready" : "processing",
			chunk_count: plan.status === "ready" ? 1 : 0,
			created_at: stamp,
			updated_at: stamp,
		};
		if (plan.listed !== false) documents.get(libraryId)?.push(doc);
		const result: ApiUploadResponse = {
			library_id: libraryId,
			doc_id: doc.id,
			title: doc.name,
			filename: file.name,
			chunk_count: doc.chunk_count,
			status: doc.status,
			accepted: plan.status === "accepted",
			mode: "live",
			simulated: false,
		};
		await route.fulfill({ status: result.accepted ? 202 : 200, json: result });
	});
	await page.goto("/app/libraries");
	await expect(
		page.getByRole("button", {
			name: `Existing ${libraries[0].name}`,
			exact: true,
		}),
	).toBeVisible();
	return { reads, submissions, cancelRequests };
}

test.beforeAll(async ({ browser }) => {
	const email = process.env.UNORAG_E2E_ADMIN_EMAIL;
	const password = process.env.UNORAG_E2E_ADMIN_PASSWORD;
	if (!email || !password)
		throw new Error("E2E administrator credentials required");
	const context = await browser.newContext({
		baseURL: process.env.UNORAG_E2E_BASE_URL,
	});
	try {
		const response = await context.request.post("/api/auth/session", {
			data: { email, password },
		});
		expect(response.ok()).toBe(true);
		cookies = await context.cookies();
	} finally {
		await context.close();
	}
});

test.beforeEach(async ({ context }) => {
	await context.addCookies(cookies);
});

test("multi-upload reports each response before a slow file finishes and preserves every failure", async ({
	page,
}, testInfo) => {
	const slow = deferred();
	const plans: Record<string, UploadPlan> = {
		"accepted.txt": { status: "accepted" },
		"ready.txt": { status: "ready" },
		"too-large.txt": { status: 413, error: "File exceeds upload limit" },
		"unsupported.txt": { status: 415, error: "Unsupported document format" },
		"slow.txt": { status: "accepted", wait: slow.promise, listed: false },
	};
	await installUploads(page, plans);
	await page.emulateMedia({ reducedMotion: "reduce" });
	const input = page.locator('input[type="file"][multiple]');
	const results = page.getByRole("region", { name: "本次上传结果" });
	const row = (filename: string) =>
		results
			.getByRole("listitem")
			.filter({ has: page.getByText(filename, { exact: true }) });
	try {
		await input.setInputFiles(
			Object.keys(plans).map((name) => ({
				name,
				mimeType: "text/plain",
				buffer: Buffer.from("Upload fixture"),
			})),
		);
		await expect(results).toContainText(libraries[0].name);
		await expect(row("accepted.txt")).toContainText("已接受");
		await expect(row("accepted.txt")).not.toContainText("已就绪");
		await expect(row("ready.txt")).toContainText("已就绪");
		await expect(row("too-large.txt")).toContainText("提交失败");
		await expect(row("too-large.txt")).toContainText(
			plans["too-large.txt"].error as string,
		);
		await expect(row("unsupported.txt")).toContainText("提交失败");
		await expect(row("unsupported.txt")).toContainText(
			plans["unsupported.txt"].error as string,
		);
		await expect(row("slow.txt")).toContainText("提交中");
		await expect(row("slow.txt").locator("svg")).toHaveCSS(
			"animation-name",
			"none",
		);
		await expect(results.getByText(/提交耗时/)).toHaveCount(0);
		await expect(input).toHaveValue("");
		await expect
			.poll(() =>
				input.evaluate((element: HTMLInputElement) => element.files?.length),
			)
			.toBe(0);
		const heldAt = Date.now();
		await page.screenshot({
			path: testInfo.outputPath("partial-upload-pending.png"),
			animations: "disabled",
		});
		const heldMs = Date.now() - heldAt;
		slow.release();
		await expect(row("slow.txt")).toContainText("已接受");
		await expect(results.getByText(/提交耗时/)).toBeVisible();
		const slowDuration =
			(await row("slow.txt")
				.getByText(/^提交 /)
				.textContent()) ?? "";
		expect(slowDuration).toMatch(/^提交 \d+(?:\.\d+)?(?:ms|s|m \d+s)$/);
		const measuredMs = slowDuration.endsWith("ms")
			? Number.parseFloat(slowDuration.slice(3))
			: Number.parseFloat(slowDuration.slice(3)) * 1000;
		expect(measuredMs).toBeGreaterThanOrEqual(heldMs - 100);
		await expect(
			row("accepted.txt").getByRole("button", {
				name: "查看文档：accepted.txt",
				exact: true,
			}),
		).toBeVisible();
		await expect(row("slow.txt").getByRole("button")).toHaveCount(0);
		await row("accepted.txt").getByRole("button").click();
		await expect(page.getByRole("dialog")).toContainText("accepted.txt");
		await page.keyboard.press("Escape");
		await input.setInputFiles([]);
		await expect(results.getByRole("listitem")).toHaveCount(5);
		await expect(row("too-large.txt")).toContainText(
			"File exceeds upload limit",
		);
		await expect
			.poll(() =>
				page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
			)
			.toBe(true);
		await page.screenshot({
			path: testInfo.outputPath("partial-upload-results.png"),
			animations: "disabled",
		});
	} finally {
		slow.release();
	}
});

test("switching libraries keeps the original upload target and refreshes its inactive query", async ({
	page,
	isMobile,
}) => {
	const slow = deferred();
	const fixture = await installUploads(page, {
		"switched.txt": { status: "ready", wait: slow.promise },
		"rejected.txt": { status: 400, error: "Rejected in original library" },
	});
	const results = page.getByRole("region", { name: "本次上传结果" });
	try {
		await page.locator('input[type="file"][multiple]').setInputFiles(
			["switched.txt", "rejected.txt"].map((name) => ({
				name,
				mimeType: "text/plain",
				buffer: Buffer.from("Switch fixture"),
			})),
		);
		await expect(results).toContainText("Rejected in original library");
		await expect.poll(() => fixture.submissions.length).toBe(2);
		await selectLibrary(page, isMobile, libraries[1]);
		await expect(
			page.getByRole("button", {
				name: `Existing ${libraries[1].name}`,
				exact: true,
			}),
		).toBeVisible();
		await expect(results).toHaveCount(0);
		const originalReads = fixture.reads.filter(
			(id) => id === libraries[0].id,
		).length;
		const otherReads = fixture.reads.filter(
			(id) => id === libraries[1].id,
		).length;
		slow.release();
		await expect
			.poll(() => fixture.reads.filter((id) => id === libraries[0].id).length)
			.toBeGreaterThan(originalReads);
		await expect(
			page.getByRole("button", { name: "上传文档", exact: true }),
		).toBeEnabled();
		expect(fixture.reads.filter((id) => id === libraries[1].id)).toHaveLength(
			otherReads,
		);
		expect(
			fixture.submissions.every(
				(upload) => upload.libraryId === libraries[0].id,
			),
		).toBe(true);
		await expect(results).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "switched.txt", exact: true }),
		).toHaveCount(0);
		await selectLibrary(page, isMobile, libraries[0]);
		await expect(results).toContainText(libraries[0].name);
		await expect(results).toContainText("已就绪");
		await expect(results).toContainText("Rejected in original library");
		await expect(
			results.getByRole("button", {
				name: "查看文档：switched.txt",
				exact: true,
			}),
		).toBeVisible();
	} finally {
		slow.release();
	}
});

test("dismissing pending results does not cancel or resurrect the accepted background submission", async ({
	page,
}) => {
	const slow = deferred();
	const fixture = await installUploads(page, {
		"dismissed.txt": { status: "accepted", wait: slow.promise },
	});
	const results = page.getByRole("region", { name: "本次上传结果" });
	try {
		await page.locator('input[type="file"][multiple]').setInputFiles({
			name: "dismissed.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("Dismiss fixture"),
		});
		await expect(results).toContainText("提交中");
		await results
			.getByRole("button", { name: "关闭上传结果", exact: true })
			.click();
		await expect(results).toHaveCount(0);
		slow.release();
		await expect(
			page.getByRole("button", { name: "dismissed.txt", exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "上传文档", exact: true }),
		).toBeEnabled();
		await expect(results).toHaveCount(0);
		expect(fixture.cancelRequests).toHaveLength(0);
		expect(fixture.submissions).toEqual([
			{ libraryId: libraries[0].id, filename: "dismissed.txt" },
		]);
	} finally {
		slow.release();
	}
});
