import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";
import { COLOR_THEMES } from "../../src/lib/appearance";
import { selectAppearanceRadio, textContrast } from "./appearance-assertions";

const resolveFromApp = createRequire(`${process.cwd()}/package.json`);
const sharp = createRequire(resolveFromApp.resolve("next/package.json"))(
	"sharp",
);

test("the selected brand stays visible in both themes and publishes explicit icon assets", async ({
	page,
}) => {
	await page.goto("/");
	const home = page.getByRole("link", { name: "UnoRAG 首页", exact: true });
	const logo = home.locator("img");
	await expect(logo).toBeVisible();
	await expect(logo).toHaveAttribute("src", "/brand/uno-mark.svg");
	await expect(
		page.locator('head link[rel="icon"][sizes="16x16"]'),
	).toHaveAttribute("href", "/favicon-16x16.png");
	await expect(
		page.locator('head link[rel="icon"][sizes="any"]'),
	).toHaveAttribute("href", "/brand/uno-favicon.svg");

	for (const mode of ["浅色", "深色"]) {
		await page.getByRole("button", { name: "外观设置", exact: true }).click();
		await selectAppearanceRadio(
			page.getByRole("radio", { name: mode, exact: true }),
		);
		await page.keyboard.press("Escape");
		await expect(page.locator('[data-slot="sheet-overlay"]')).toBeHidden();
		await expect(page.locator("html")).toHaveClass(
			mode === "深色" ? /dark/ : /light/,
		);
		const { data } = await sharp(await logo.screenshot())
			.resize(32, 32)
			.ensureAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true });
		const stroke = data[(16 * 32 + 6) * 4];
		if (mode === "深色") expect(stroke).toBeGreaterThan(220);
		else expect(stroke).toBeLessThan(80);
	}

	for (const path of [
		"/favicon-16x16.png",
		"/favicon-32x32.png",
		"/apple-touch-icon.png",
		"/brand/uno-favicon.svg",
	]) {
		const response = await page.request.get(path);
		expect(response.ok()).toBe(true);
	}
});

test("public evidence example has real source text, reversible views and no API calls", async ({
	page,
}, info) => {
	const errors: string[] = [];
	const apiRequests: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("request", (request) => {
		if (new URL(request.url()).pathname.startsWith("/api/"))
			apiRequests.push(request.url());
	});
	await page.goto("/");
	await expect(
		page.getByRole("heading", {
			name: "让内部资料，成为可核对的答案。",
			exact: true,
		}),
	).toBeVisible();
	const example = page.getByRole("region", {
		name: "知识工作流示例",
		exact: true,
	});
	await example
		.getByRole("button", { name: "查看引用 1：员工手册", exact: true })
		.click();
	await expect(example.getByRole("blockquote")).toContainText(
		"返岗后三个工作日内",
	);
	await expect(
		example.getByRole("button", { name: "原文", exact: true }),
	).toHaveAttribute("aria-pressed", "true");
	await example
		.getByRole("button", { name: "返回示例回答", exact: true })
		.click();
	await expect(
		example.getByRole("button", { name: "回答", exact: true }),
	).toHaveAttribute("aria-pressed", "true");
	await example.getByRole("button", { name: "链路", exact: true }).click();
	await expect(
		example.getByRole("listitem").filter({ hasText: "引用校验" }),
	).toBeVisible();
	await expect(example.getByRole("listitem")).toHaveCount(6);
	await page.screenshot({
		path: info.outputPath("landing-interaction.png"),
		animations: "disabled",
	});
	expect(apiRequests).toEqual([]);
	expect(errors).toEqual([]);
});

test("themes, radius, public assets and layouts stay coherent across viewports", async ({
	page,
}, info) => {
	test.setTimeout(90_000);
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto("/");
	await page.getByRole("button", { name: "外观设置", exact: true }).click();
	for (const color of COLOR_THEMES) {
		await selectAppearanceRadio(
			page.getByRole("radio", { name: color.label, exact: true }),
		);
		for (const mode of ["浅色", "深色"]) {
			await selectAppearanceRadio(
				page.getByRole("radio", { name: mode, exact: true }),
			);
			await expect(page.locator("html")).toHaveAttribute(
				"data-color-theme",
				color.id,
			);
			await expect(page.locator("html")).toHaveClass(
				mode === "深色" ? /\bdark\b/ : /\blight\b/,
			);
			await page.keyboard.press("Escape");
			await expect(page.getByRole("dialog")).toHaveCount(0);
			await expect(
				page.getByRole("button", { name: "外观设置", exact: true }),
			).toBeFocused();
			const example = page.getByRole("region", {
				name: "知识工作流示例",
				exact: true,
			});
			const citation = example.getByRole("button", {
				name: "查看引用 1：员工手册",
				exact: true,
			});
			await page.mouse.move(0, 0);
			expect(
				(await textContrast(citation)).ratio,
				`${color.id}/${mode}/citation resting`,
			).toBeGreaterThanOrEqual(4.5);
			if (await page.evaluate(() => matchMedia("(hover: hover)").matches)) {
				await citation.hover();
				expect(await citation.evaluate((el) => el.matches(":hover"))).toBe(
					true,
				);
				expect(
					(await textContrast(citation)).ratio,
					`${color.id}/${mode}/citation hover`,
				).toBeGreaterThanOrEqual(4.5);
			}
			await citation.click();
			expect(
				(await textContrast(example.locator("mark"))).ratio,
				`${color.id}/${mode}/highlight`,
			).toBeGreaterThanOrEqual(4.5);
			await example
				.getByRole("button", { name: "返回示例回答", exact: true })
				.click();
			for (const [width, height] of [
				[320, 568],
				[390, 844],
				[768, 1024],
				[1024, 768],
				[1440, 900],
				[1920, 1080],
			]) {
				await page.evaluate(() =>
					window.scrollTo({ top: 0, behavior: "instant" }),
				);
				await page.setViewportSize({ width, height });
				await expect
					.poll(() =>
						page.evaluate(
							() => document.documentElement.scrollWidth <= innerWidth + 1,
						),
					)
					.toBe(true);
				await expect(
					page.getByRole("heading", {
						name: "让内部资料，成为可核对的答案。",
						exact: true,
					}),
				).toBeInViewport();
			}
			await page.screenshot({
				path: info.outputPath(`landing-${color.id}-${mode}.png`),
				animations: "disabled",
			});
			await page.getByRole("button", { name: "外观设置", exact: true }).click();
		}
	}
	await page.getByRole("slider", { name: "圆角大小", exact: true }).focus();
	await page.keyboard.press("End");
	await page.keyboard.press("Escape");
	await expect(page.locator("html")).toHaveAttribute("data-radius", "12");
	await page
		.getByRole("heading", { name: /回答之外/ })
		.scrollIntoViewIfNeeded();
	await expect
		.poll(() =>
			page
				.locator("main img")
				.evaluateAll((images) =>
					images
						.filter((image) => image.getClientRects().length > 0)
						.every(
							(image) =>
								(image as HTMLImageElement).complete &&
								(image as HTMLImageElement).naturalWidth > 0,
						),
				),
		)
		.toBe(true);
	await expect(page.locator(".landing-enter").first()).toHaveCSS(
		"animation-name",
		"none",
	);
});

test("mobile menu, anchor links and keyboard bypass stay operable", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/");
	await expect(
		page.getByRole("button", { name: "外观设置", exact: true }),
	).toBeEnabled();
	await page.keyboard.press("Tab");
	await expect(
		page.getByRole("link", { name: "跳至主要内容", exact: true }),
	).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.locator("#main-content")).toBeFocused();
	await page.getByRole("button", { name: "打开导航", exact: true }).click();
	const nav = page.getByRole("navigation", { name: "手机导航", exact: true });
	await nav.getByRole("link", { name: "可观测", exact: true }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page).toHaveURL(/#observability$/);
	await expect(page.locator("#observability")).toBeInViewport();
	const details = page
		.locator("summary")
		.filter({ hasText: "需要把文档拿去训练模型吗？" });
	await details.scrollIntoViewIfNeeded();
	await details.click();
	await expect(
		page.getByText("不需要。UnoRAG 在回答时先检索当前成员有权访问的文档片段", {
			exact: false,
		}),
	).toBeVisible();
});

test("overlay scrollbars prevent inset layout shift when opening sheets and scrolling", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/");
	const windowScrollbar = page.locator('[data-slot="window-scrollbar"]');
	await expect(windowScrollbar).toBeAttached();

	const before = await page.evaluate(() => {
		const header = document.querySelector("header")?.getBoundingClientRect();
		const heading = document.querySelector("h1")?.getBoundingClientRect();
		return {
			insetScrollbar: window.innerWidth - document.documentElement.clientWidth,
			scrollable: document.documentElement.scrollHeight > window.innerHeight,
			headerWidth: header?.width ?? 0,
			headingLeft: heading?.left ?? 0,
		};
	});
	expect(before.scrollable).toBe(true);
	expect(before.insetScrollbar).toBe(0);

	// Scrolling reveals the floating overlay scrollbar without reserving layout width.
	await page.evaluate(() => window.scrollTo({ top: 400, behavior: "instant" }));
	await expect(windowScrollbar).toHaveCSS("opacity", "1");

	// Opening the modal Appearance sheet must not shift header/content or inject classic inset scroll-lock.
	await page.getByRole("button", { name: "外观设置", exact: true }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	const whileOpen = await page.evaluate(() => {
		const header = document.querySelector("header")?.getBoundingClientRect();
		const heading = document.querySelector("h1")?.getBoundingClientRect();
		const sheetViewport = document.querySelector(
			'[data-slot="sheet-content"] [data-slot="scroll-area-viewport"]',
		) as HTMLElement | null;
		return {
			insetScrollbar: window.innerWidth - document.documentElement.clientWidth,
			legacyScrollLock: document.documentElement.hasAttribute(
				"data-base-ui-scroll-locked",
			),
			headerWidth: header?.width ?? 0,
			headingLeft: heading?.left ?? 0,
			sheetInsetScrollbar: sheetViewport
				? sheetViewport.offsetWidth - sheetViewport.clientWidth
				: -1,
		};
	});
	expect(whileOpen.insetScrollbar).toBe(0);
	expect(whileOpen.legacyScrollLock).toBe(false);
	expect(Math.abs(whileOpen.headerWidth - before.headerWidth)).toBeLessThan(
		0.5,
	);
	expect(Math.abs(whileOpen.headingLeft - before.headingLeft)).toBeLessThan(
		0.5,
	);
	expect(whileOpen.sheetInsetScrollbar).toBe(0);

	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
});
