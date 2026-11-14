import { type Cookie, expect, type Locator, test } from "@playwright/test";
import type {
	ApiDocument,
	ApiJob,
	ApiLibrary,
	ApiUploadResponse,
} from "../../src/lib/api";
import { chooseSelect } from "./select-helpers";

let cookies: Cookie[] = [];
test.beforeAll(async ({ browser }) => {
	const email = process.env.UNORAG_E2E_ADMIN_EMAIL;
	const password = process.env.UNORAG_E2E_ADMIN_PASSWORD;
	if (!email || !password)
		throw new Error("E2E administrator credentials required");
	const context = await browser.newContext({
		baseURL: process.env.UNORAG_E2E_BASE_URL,
	});
	try {
		const auth = await context.request.post("/api/auth/session", {
			data: { email, password },
		});
		expect(auth.ok()).toBe(true);
		cookies = await context.cookies();
	} finally {
		await context.close();
	}
});
test.beforeEach(async ({ context }) => {
	await context.addCookies(cookies);
});

async function expectThemeColors(
	action: Locator,
	background = "--primary",
	foreground = "--primary-foreground",
) {
	await expect(action).toBeVisible();
	await expect
		.poll(() =>
			action.evaluate(
				(element, tokens) => {
					const probe = document.createElement("span");
					probe.style.backgroundColor = `var(${tokens.background})`;
					probe.style.color = `var(${tokens.foreground})`;
					document.body.append(probe);
					const expected = getComputedStyle(probe);
					const actual = getComputedStyle(element);
					const matches =
						actual.backgroundColor === expected.backgroundColor &&
						actual.color === expected.color;
					probe.remove();
					return matches;
				},
				{ background, foreground },
			),
		)
		.toBe(true);
}

test("library loading and read failure never claim zero libraries and retry in place", async ({
	page,
	isMobile,
}) => {
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let failing = true;
	await page.route("**/api/libraries", async (route) => {
		await held;
		await route.fulfill(
			failing
				? { status: 503, json: { detail: "fixture library read unavailable" } }
				: { json: [] },
		);
	});
	try {
		await page.goto("/app/libraries");
		await expect(
			page.getByRole("status").filter({ hasText: "正在加载知识库" }),
		).toBeVisible();
		await expect(page.getByText("还没有知识库", { exact: true })).toHaveCount(
			0,
		);
		if (!isMobile) {
			const sidebar = page.getByRole("complementary", { name: "知识库导航" });
			await expect(sidebar.getByText("知识库与文档数量待确认")).toBeVisible();
			const list = sidebar.getByRole("list");
			await expect(list.getByRole("listitem")).toHaveCount(1);
			await expect(list.getByRole("status")).toBeVisible();
		}
		release();
		await expect(
			page.getByText("知识库列表未能加载，暂无法确认资料数量。", {
				exact: true,
			}),
		).toBeVisible();
		await expect(page.getByText("还没有知识库", { exact: true })).toHaveCount(
			0,
		);
		failing = false;
		await page
			.getByRole("button", { name: "重试加载知识库", exact: true })
			.click();
		await expect(
			page.getByText("还没有知识库", { exact: true }).last(),
		).toBeVisible();
		await expect(
			page.getByRole("alert").filter({ hasText: "知识库加载失败" }),
		).toHaveCount(0);
	} finally {
		release();
	}
});

test("pending and failed document reads never masquerade as an empty knowledge base", async ({
	page,
}) => {
	const stamp = "2026-11-13T00:00:00Z";
	const libraryId = "delayed-library";
	await page.route("**/api/libraries", (route) =>
		route.fulfill({
			json: [
				{
					id: libraryId,
					name: "延迟读取资料",
					status: "ready",
					doc_count: 1,
					ready_count: 1,
					created_at: stamp,
					updated_at: stamp,
				},
			],
		}),
	);
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let failing = true;
	await page.route(`**/api/libraries/${libraryId}/documents`, async (route) => {
		await held;
		await route.fulfill(
			failing
				? { status: 503, json: { detail: "fixture read unavailable" } }
				: {
						json: [
							{
								id: "delayed-doc",
								library_id: libraryId,
								name: "加载恢复后的文档",
								filename: "recovered.md",
								content_type: "text/markdown",
								status: "ready",
								chunk_count: 2,
								job_status: "completed",
								created_at: stamp,
								updated_at: stamp,
							},
						],
					},
		);
	});
	try {
		await page.goto("/app/libraries");
		await expect(
			page.getByRole("status").filter({ hasText: "正在加载文档" }),
		).toBeVisible();
		const stats = page.getByRole("region", { name: "文档与任务统计" });
		await expect(
			stats.getByText("文档", { exact: true }).locator(".."),
		).toHaveText("文档--");
		await expect(page.getByText("尚无文档", { exact: true })).toHaveCount(0);
		release();
		await expect(
			page.getByText("文档列表未能加载，暂无法确认资料数量。", { exact: true }),
		).toBeVisible();
		await expect(
			stats.getByText("文档", { exact: true }).locator(".."),
		).toHaveText("文档--");
		failing = false;
		await page
			.getByRole("button", { name: "重试加载文档", exact: true })
			.click();
		await expect(
			page.getByRole("button", { name: "加载恢复后的文档", exact: true }),
		).toBeVisible();
		await expect(
			stats.getByText("文档", { exact: true }).locator(".."),
		).toHaveText("文档1");
		await expect(
			page.getByRole("alert").filter({ hasText: "文档列表加载失败" }),
		).toHaveCount(0);
	} finally {
		release();
	}
});

test("latest-task filters do not infer completion from document readiness", async ({
	page,
}) => {
	const stamp = "2026-11-13T00:00:00Z";
	const statuses = ["failed", "running", "completed", undefined];
	const names = ["待更新制度", "处理中的手册", "已完成索引", "历史资料"];
	const docs: ApiDocument[] = names.map((name, i) => ({
		id: `task-doc-${i}`,
		library_id: "task-library",
		name,
		filename: `${name}.md`,
		content_type: "text/markdown",
		status: i === 1 ? "processing" : "ready",
		chunk_count: 3,
		job_status: statuses[i],
		job_stage: i === 1 ? "embedding" : "done",
		created_at: stamp,
		updated_at: stamp,
	}));
	await page.route("**/api/libraries", (route) =>
		route.fulfill({
			json: [
				{
					id: "task-library",
					name: "任务筛选资料",
					status: "ready",
					doc_count: 4,
					ready_count: 3,
					created_at: stamp,
					updated_at: stamp,
				},
			],
		}),
	);
	await page.route("**/api/libraries/task-library/documents", (route) =>
		route.fulfill({ json: docs }),
	);
	await page.goto("/app/libraries");
	await expect(
		page.getByRole("button", { name: "历史资料", exact: true }),
	).toBeVisible();
	const stats = page.getByRole("region", {
		name: "文档与任务统计",
		exact: true,
	});
	await expect(
		stats.getByText("任务完成", { exact: true }).locator(".."),
	).toHaveText("任务完成1");
	await expect(page.getByText("任务未记录", { exact: true })).toBeVisible();
	const filter = page.getByRole("combobox", {
		name: "最近处理任务",
		exact: true,
	});
	await chooseSelect(filter, "任务失败");
	await expect(
		page.getByRole("button", { name: "待更新制度", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "已完成索引", exact: true }),
	).toHaveCount(0);
	await expect(page.getByText("处理失败", { exact: true })).toBeVisible();
	await chooseSelect(filter, "任务处理中");
	await expect(
		page.getByRole("button", { name: "处理中的手册", exact: true }),
	).toBeVisible();
	await expect(page.getByText("向量化", { exact: true })).toBeVisible();
	await page
		.getByRole("textbox", { name: "搜索文档", exact: true })
		.fill("不存在");
	await expect(page.getByText("没有匹配的文档", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "清除筛选", exact: true }).click();
	await expect(filter).toHaveText("全部任务");
	await expect(
		page.getByRole("button", { name: "历史资料", exact: true }),
	).toBeVisible();
});

test("library navigation keeps search, selection, collapse and document actions usable", async ({
	page,
	isMobile,
}, testInfo) => {
	const stamp = "2026-01-01T00:00:00.000Z";
	const libraries: ApiLibrary[] = ["产品资料", "团队制度", "运维手册"].map(
		(name, index) => ({
			id: `navigation-${index}`,
			name,
			description: `${name}归档`,
			status: "ready",
			doc_count: 1,
			ready_count: 1,
			requires_reindex: index === 0,
			created_at: stamp,
			updated_at: stamp,
		}),
	);
	await page.route("**/api/libraries", (route) =>
		route.fulfill({ json: libraries }),
	);
	await page.route("**/api/libraries/*/documents", (route) => {
		const libraryId = new URL(route.request().url()).pathname.split("/")[3];
		const document: ApiDocument = {
			id: `doc-${libraryId}`,
			library_id: libraryId,
			name: "项目说明",
			filename: "产品说明.pdf",
			content_type: "application/pdf",
			status: "ready",
			chunk_count: 12,
			size_bytes: 10240,
			has_file: true,
			created_at: stamp,
			updated_at: stamp,
		};
		return route.fulfill({ json: [document] });
	});
	await page.goto("/app/libraries");
	for (const theme of ["Vercel", "Claude", "Violet Bloom"]) {
		for (const mode of ["浅色", "深色"]) {
			await page.getByRole("button", { name: "外观设置", exact: true }).click();
			await page.getByRole("radio", { name: theme, exact: true }).check();
			await page.getByRole("radio", { name: mode, exact: true }).check();
			await page.keyboard.press("Escape");
			await expectThemeColors(
				page.getByRole("button", { name: "新建知识库", exact: true }).first(),
			);
			await expectThemeColors(
				page.getByRole("button", { name: "上传文档", exact: true }),
			);
			await expectThemeColors(
				page.getByText("需要重索引", { exact: true }),
				"--warning",
				"--warning-foreground",
			);
		}
	}
	await expect(page.getByText("自动 分块", { exact: true })).toHaveCSS(
		"font-size",
		"12px",
	);
	await expect(page.getByText("自动 解析", { exact: true })).toHaveCSS(
		"font-size",
		"12px",
	);
	await page
		.getByRole("button", { name: "新建知识库", exact: true })
		.first()
		.click();
	await expectThemeColors(
		page.getByRole("dialog").getByRole("button", { name: "创建", exact: true }),
	);
	await page
		.getByRole("button", { name: "解析策略（质量 / 扫描件）", exact: true })
		.click();
	await page.getByRole("button", { name: "解析质量说明", exact: true }).click();
	await expect(
		page
			.getByRole("dialog")
			.last()
			.getByText(/高质量解析在部署允许/),
	).toHaveCSS("font-size", "14px");
	await page.keyboard.press("Escape");
	await page.getByRole("dialog").getByRole("button", { name: "取消" }).click();
	if (!isMobile) {
		const navigation = page.getByRole("complementary", { name: "知识库导航" });
		await navigation.getByRole("textbox", { name: "搜索知识库" }).fill("制度");
		await expect(
			navigation.getByRole("button", { name: /团队制度/ }),
		).toBeVisible();
		await expect(
			navigation.getByRole("button", { name: /产品资料/ }),
		).toHaveCount(0);
		await navigation.getByRole("button", { name: /团队制度/ }).click();
		await expect(
			navigation.getByRole("button", { name: /团队制度/ }),
		).toHaveAttribute("aria-current", "true");
		await expect(page.getByRole("heading", { level: 3 })).toContainText(
			"团队制度",
		);
		await navigation
			.getByRole("button", { name: "收起知识库导航", exact: true })
			.click();
		await expect(
			page.getByRole("button", { name: "项目说明", exact: true }),
		).toBeVisible();
		await navigation
			.getByRole("button", { name: "展开知识库导航", exact: true })
			.click();
		await expect(
			navigation.getByRole("textbox", { name: "搜索知识库" }),
		).toHaveValue("制度");
		await navigation.getByRole("textbox", { name: "搜索知识库" }).fill("");
	}
	await page.getByRole("button", { name: "操作", exact: true }).click();
	await expect(
		page.getByRole("menuitem", { name: "替换文件", exact: true }),
	).toBeVisible();
	await expect(page.getByRole("menuitem", { name: /重索引/ })).toBeVisible();
	await page.keyboard.press("Escape");
	if (!isMobile) {
		for (const width of [320, 768, 1024, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			await expect(
				page.getByRole("button", { name: "项目说明", exact: true }),
			).toBeVisible();
			await expect(
				page.getByRole("button", { name: "操作", exact: true }),
			).toBeVisible();
			await expect
				.poll(() =>
					page
						.getByRole("button", { name: "操作", exact: true })
						.evaluate((button) => {
							const bounds = button.getBoundingClientRect();
							const container = button
								.closest('[data-slot="table-container"]')
								?.getBoundingClientRect();
							return Boolean(
								container &&
									bounds.width >= 44 &&
									bounds.right <= container.right &&
									bounds.left >= container.left,
							);
						}),
				)
				.toBe(true);
			await expect
				.poll(() =>
					page.evaluate(
						() => document.documentElement.scrollWidth <= innerWidth,
					),
				)
				.toBe(true);
			await page.screenshot({
				path: testInfo.outputPath(`library-${width}.png`),
				animations: "disabled",
			});
		}
	}
	await expect
		.poll(() =>
			page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
		)
		.toBe(true);
	await page.screenshot({
		path: testInfo.outputPath("library-navigation.png"),
		animations: "disabled",
	});
});

test("ingest polling cannot cancel the post-create refresh or lose library selection", async ({
	page,
	isMobile,
}, testInfo) => {
	const stamp = "2026-01-01T00:00:00.000Z";
	const existing: ApiLibrary = {
		id: "polling-existing",
		name: "Indexing fixture",
		status: "indexing",
		doc_count: 1,
		ready_count: 0,
		created_at: stamp,
		updated_at: stamp,
	};
	const created: ApiLibrary = {
		id: "polling-created",
		name: "Created during polling",
		status: "empty",
		doc_count: 0,
		ready_count: 0,
		created_at: stamp,
		updated_at: stamp,
	};
	let didCreate = false;
	let held = false;
	let pollsAfterCreate = 0;
	let release = () => {};
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/libraries", async (route) => {
		if (route.request().method() === "POST") {
			didCreate = true;
			await route.fulfill({ status: 201, json: created });
			return;
		}
		if (didCreate && !held) {
			held = true;
			await pending;
		}
		await route
			.fulfill({ json: didCreate ? [existing, created] : [existing] })
			.catch(() => {});
	});
	await page.route("**/api/libraries/*/documents", async (route) => {
		if (didCreate) pollsAfterCreate += 1;
		const libraryId = new URL(route.request().url()).pathname.split("/")[3];
		const documents: ApiDocument[] =
			libraryId === existing.id
				? [
						{
							id: "polling-document",
							library_id: existing.id,
							name: "Pending fixture",
							filename: "pending.pdf",
							content_type: "application/pdf",
							status: "processing",
							chunk_count: 0,
							created_at: stamp,
							updated_at: stamp,
						},
					]
				: [];
		await route.fulfill({ json: documents });
	});
	try {
		await page.goto("/app/libraries");
		const selected = isMobile
			? page.getByRole("combobox", { name: "当前知识库", exact: true })
			: page.getByRole("heading", { level: 3 });
		if (isMobile) await expect(selected).toHaveValue(new RegExp(existing.name));
		else await expect(selected).toContainText(existing.name);
		await page
			.getByRole("button", { name: "新建知识库", exact: true })
			.first()
			.click();
		await page
			.getByRole("dialog")
			.getByRole("textbox", { name: "名称", exact: true })
			.fill(created.name);
		await page
			.getByRole("dialog")
			.getByRole("button", { name: "创建", exact: true })
			.click();
		await expect
			.poll(() => pollsAfterCreate, { timeout: 12000 })
			.toBeGreaterThanOrEqual(2);
		expect(held).toBe(true);
		release();
		if (isMobile)
			await expect(selected).toHaveValue(new RegExp(created.name), {
				timeout: 10000,
			});
		else await expect(selected).toContainText(created.name, { timeout: 10000 });
		await expect(
			page.getByRole("button", { name: "上传文档", exact: true }),
		).toBeEnabled();
		await page.screenshot({
			path: testInfo.outputPath("created-library.png"),
			animations: "disabled",
		});
	} finally {
		release();
	}
});

for (const refreshFailure of ["delayed", "unavailable"] as const) {
	test(`confirmed creation selects the new upload target before a ${refreshFailure} list refresh and preserves it after recovery`, async ({
		page,
		isMobile,
	}) => {
		const stamp = "2026-01-01T00:00:00.000Z";
		const existing: ApiLibrary = {
			id: "create-target-a",
			name: "Existing library A",
			status: "ready",
			doc_count: 1,
			ready_count: 1,
			created_at: stamp,
			updated_at: stamp,
		};
		const created: ApiLibrary = {
			...existing,
			id: "create-target-b",
			name: "Created library B",
			status: "empty",
			doc_count: 0,
			ready_count: 0,
		};
		const documents = new Map<string, ApiDocument[]>([
			[
				existing.id,
				[
					{
						id: "existing-target-document",
						library_id: existing.id,
						name: "Existing A document",
						filename: "existing-a.txt",
						content_type: "text/plain",
						status: "ready",
						chunk_count: 1,
						created_at: stamp,
						updated_at: stamp,
					},
				],
			],
			[created.id, []],
		]);
		let createCount = 0;
		let postCreateReads = 0;
		let successfulRefreshes = 0;
		let refreshState: "delayed" | "unavailable" | "recovered" = refreshFailure;
		function deferred() {
			let release = () => {};
			const promise = new Promise<void>((resolve) => {
				release = resolve;
			});
			return { promise, release };
		}
		const pending = deferred();
		const oldList = deferred();
		let holdOldList = false;
		let oldListStarted = false;
		let oldListFinished = false;
		const submissions: { libraryId: string; filename: string }[] = [];
		await page.route("**/api/libraries", async (route) => {
			if (route.request().method() === "POST") {
				expect(route.request().postDataJSON()).toMatchObject({
					name: created.name,
				});
				createCount += 1;
				await route.fulfill({ status: 201, json: created });
				return;
			}
			if (createCount === 0) {
				if (holdOldList) {
					oldListStarted = true;
					await oldList.promise;
					await route.fulfill({ json: [existing] }).catch(() => {});
					oldListFinished = true;
				} else {
					await route.fulfill({ json: [existing] });
				}
				return;
			}
			postCreateReads += 1;
			if (refreshState === "delayed") await pending.promise;
			if (refreshState === "unavailable") {
				await route.fulfill({
					status: 503,
					json: { detail: "fixture post-create library refresh unavailable" },
				});
				return;
			}
			await route
				.fulfill({
					json: [existing, created].map((library) => ({
						...library,
						status: documents.get(library.id)?.length ? "ready" : "empty",
						doc_count: documents.get(library.id)?.length ?? 0,
						ready_count: documents.get(library.id)?.length ?? 0,
					})),
				})
				.then(() => {
					successfulRefreshes += 1;
				})
				.catch(() => {});
		});
		await page.route("**/api/libraries/*/documents", async (route) => {
			const request = route.request();
			const libraryId = new URL(request.url()).pathname.split("/")[3];
			if (request.method() === "GET") {
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
			expect(await file.text()).toBe("Created library upload target fixture");
			submissions.push({ libraryId, filename: file.name });
			const document: ApiDocument = {
				id: `created-target-${file.name}`,
				library_id: libraryId,
				name: file.name,
				filename: file.name,
				content_type: "text/plain",
				status: "ready",
				chunk_count: 1,
				created_at: stamp,
				updated_at: stamp,
			};
			documents.get(libraryId)?.push(document);
			const result: ApiUploadResponse = {
				library_id: libraryId,
				doc_id: document.id,
				title: document.name,
				filename: file.name,
				chunk_count: 1,
				status: "ready",
				accepted: false,
				mode: "live",
				simulated: false,
			};
			await route.fulfill({ json: result });
		});
		async function expectSelected(library: ApiLibrary, label = library.name) {
			if (isMobile) {
				await expect(
					page.getByRole("combobox", { name: "当前知识库", exact: true }),
				).toHaveValue(label);
			} else {
				await expect(page.getByRole("heading", { level: 3 })).toContainText(
					library.name,
				);
				await expect(
					page
						.getByRole("complementary", { name: "知识库导航" })
						.getByRole("button", { name: new RegExp(library.name) }),
				).toHaveAttribute("aria-current", "true");
			}
		}
		const dialog = page.getByRole("dialog");
		const upload = page.getByRole("button", { name: "上传文档", exact: true });
		const refreshError = page
			.getByRole("alert")
			.filter({ hasText: "知识库加载失败" });
		async function uploadFile(filename: string) {
			const chooser = page.waitForEvent("filechooser");
			await upload.click();
			await (await chooser).setFiles({
				name: filename,
				mimeType: "text/plain",
				buffer: Buffer.from("Created library upload target fixture"),
			});
			const results = page.getByRole("region", { name: "本次上传结果" });
			await expect(results).toContainText(created.name);
			await expect(results).toContainText(filename);
			await expect(results).toContainText("已就绪");
		}
		try {
			await page.goto("/app/libraries");
			await expectSelected(existing);
			await expect(
				page.getByRole("button", { name: "Existing A document", exact: true }),
			).toBeVisible();
			holdOldList = true;
			await page.getByRole("button", { name: "刷新文档", exact: true }).click();
			await expect.poll(() => oldListStarted).toBe(true);
			await page
				.getByRole("button", { name: "新建知识库", exact: true })
				.first()
				.click();
			await dialog
				.getByRole("textbox", { name: "名称", exact: true })
				.fill(created.name);
			await dialog.getByRole("button", { name: "创建", exact: true }).click();
			await expect(dialog).toBeHidden();
			await expect.poll(() => postCreateReads).toBeGreaterThan(0);
			if (refreshFailure === "unavailable")
				await expect(refreshError).toBeVisible();
			expect(successfulRefreshes).toBe(0);
			await expectSelected(created, `${created.name} · 空`);
			oldList.release();
			await expect.poll(() => oldListFinished).toBe(true);
			await expectSelected(created, `${created.name} · 空`);
			await expect(upload).toBeEnabled();
			await uploadFile("before-refresh.txt");
			expect(submissions).toEqual([
				{ libraryId: created.id, filename: "before-refresh.txt" },
			]);
			await expect.poll(() => postCreateReads).toBeGreaterThanOrEqual(2);
			expect(successfulRefreshes).toBe(0);
			expect(createCount).toBe(1);
			await expect(dialog).toBeHidden();
			await expectSelected(created, `${created.name} · 空`);
			if (refreshFailure === "unavailable") {
				await expect(upload).toBeEnabled();
				await expect(refreshError).toBeVisible();
			}
			refreshState = "recovered";
			pending.release();
			await expect(upload).toBeEnabled();
			await expect(
				page.getByRole("button", { name: "before-refresh.txt", exact: true }),
			).toBeVisible();
			const recovered = page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === "/api/libraries" &&
					response.request().method() === "GET" &&
					response.status() === 200,
			);
			await page.getByRole("button", { name: "刷新文档", exact: true }).click();
			await recovered;
			await expect(refreshError).toHaveCount(0);
			await expectSelected(created);
			await expect(dialog).toBeHidden();
			await uploadFile("after-recovery.txt");
			await expect(upload).toBeEnabled();
			expect(createCount).toBe(1);
			expect(submissions).toEqual([
				{ libraryId: created.id, filename: "before-refresh.txt" },
				{ libraryId: created.id, filename: "after-recovery.txt" },
			]);
			await expectSelected(created);
		} finally {
			oldList.release();
			pending.release();
		}
	});
}

test("PDF detail shows observed parser phases without inventing upstream compute time", async ({
	page,
}, testInfo) => {
	const stamp = "2026-01-01T00:00:00.000Z";
	const library: ApiLibrary = {
		id: "timing-library",
		name: "Timing fixture",
		status: "ready",
		doc_count: 1,
		ready_count: 1,
		created_at: stamp,
		updated_at: stamp,
	};
	const report = {
		parser: "mineru",
		backend: "typescript",
		metrics: {
			provider: "302ai",
			external_data_processing: true,
			parser_timing: {
				schema_version: 1,
				analysis_ms: 50,
				submission_ms: 100,
				provider_wait_ms: 2000,
				result_fetch_ms: 300,
				poll_count: 3,
				retry_count: 1,
			},
		},
	};
	const document: ApiDocument = {
		id: "timing-document",
		library_id: library.id,
		name: "timed.pdf",
		filename: "timed.pdf",
		content_type: "application/pdf",
		status: "ready",
		chunk_count: 2,
		job_id: "timing-job",
		parser_report: report,
		has_file: true,
		created_at: stamp,
		updated_at: stamp,
	};
	const job: ApiJob = {
		id: "timing-job",
		type: "document.ingest",
		status: "completed",
		stage: "done",
		progress: 100,
		attempt: 1,
		max_attempts: 5,
		document_id: document.id,
		document_version_id: "timing-version",
		generation_id: "timing-generation",
		library_id: library.id,
		created_at: stamp,
		updated_at: stamp,
		parser_report: report,
		started_at: stamp,
		finished_at: "2026-01-01T00:00:03.000Z",
		stage_runs: [],
	};
	await page.route("**/api/libraries", (route) =>
		route.fulfill({ json: [library] }),
	);
	await page.route("**/api/libraries/*/documents", (route) =>
		route.fulfill({ json: [document] }),
	);
	await page.route("**/api/libraries/*/documents/*/versions", (route) =>
		route.fulfill({ json: [] }),
	);
	await page.route("**/api/jobs/timing-job", (route) =>
		route.fulfill({ json: job }),
	);
	await page.goto("/app/libraries");
	await page.getByRole("button", { name: "timed.pdf", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByText("任务等待（含轮询）", { exact: true }),
	).toBeVisible();
	await expect(
		dialog.getByText("结果获取与转换", { exact: true }),
	).toBeVisible();
	await expect(dialog.getByText("上游推理耗时", { exact: true })).toHaveCount(
		0,
	);
	await expect
		.poll(() => dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
		.toBe(true);
	await page.screenshot({
		path: testInfo.outputPath("parser-timing.png"),
		animations: "disabled",
	});
});
