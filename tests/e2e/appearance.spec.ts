import { expect, test } from "@playwright/test";
import { COLOR_THEMES } from "../../src/lib/appearance";
import { textContrast } from "./appearance-assertions";

test("stored appearance is restored before hydration bundles are available", async ({
	page,
}) => {
	await page.addInitScript(() => {
		localStorage.setItem(
			"unorag-appearance-v1",
			JSON.stringify({ color: "claude", radius: "soft" }),
		);
		localStorage.setItem("unorag-theme", "dark");
	});
	await page.route("**/_next/static/**/*.js*", (route) => route.abort());
	await page.goto("/login");
	await expect(page.locator("html")).toHaveAttribute(
		"data-color-theme",
		"claude",
	);
	await expect(page.locator("html")).toHaveAttribute("data-radius", "8");
	await expect(page.locator("html")).toHaveClass(/dark/);
	await expect(
		page.getByRole("heading", { name: "登录 UnoRAG", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("status", { name: "正在加载登录表单", exact: true }),
	).toBeVisible();
	await expect(page.locator('input[type="password"]')).toHaveCount(0);
});

test("appearance applies globally, persists, follows system, syncs tabs and restores defaults", async ({
	page,
	context,
}, testInfo) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.emulateMedia({ colorScheme: "light" });
	await page.goto("/login");
	await page.getByRole("button", { name: "外观设置", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "外观", exact: true });
	await dialog.getByRole("radio", { name: "Claude", exact: true }).check();
	await dialog.getByRole("slider", { name: "圆角大小", exact: true }).focus();
	await page.keyboard.press("End");
	await dialog.getByRole("radio", { name: "深色", exact: true }).check();
	await expect(page.locator("html")).toHaveAttribute(
		"data-color-theme",
		"claude",
	);
	await expect(page.locator("html")).toHaveAttribute("data-radius", "12");
	await expect(page.locator("html")).toHaveClass(/dark/);
	await page.screenshot({
		path: testInfo.outputPath("appearance-claude-dark.png"),
		animations: "disabled",
	});
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("button", { name: "外观设置", exact: true }),
	).toBeFocused();
	await page.reload();
	await expect(page.locator("html")).toHaveAttribute(
		"data-color-theme",
		"claude",
	);
	await expect(
		page.getByRole("button", {
			name: "登录",
			exact: true,
			includeHidden: true,
		}),
	).toHaveCSS("border-radius", "12px");
	const other = await context.newPage();
	await other.goto("/login");
	await page.getByRole("button", { name: "外观设置", exact: true }).click();
	await dialog.getByRole("slider", { name: "圆角大小", exact: true }).focus();
	await page.keyboard.press("Home");
	await expect(other.locator("html")).toHaveAttribute("data-radius", "0");
	await expect(
		other.getByRole("button", {
			name: "登录",
			exact: true,
			includeHidden: true,
		}),
	).toHaveCSS("border-radius", "0px");
	await dialog.getByRole("button", { name: "恢复默认" }).click();
	await expect(other.locator("html")).toHaveAttribute(
		"data-color-theme",
		"vercel",
	);
	await expect(page.locator("html")).toHaveClass(/dark/);
	await dialog.getByRole("radio", { name: "跟随系统", exact: true }).check();
	await expect(page.locator("html")).not.toHaveClass(/dark/);
	await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
	await expect(page.locator("html")).toHaveClass(/dark/);
	await expect(dialog).toHaveCSS("transition-duration", "1e-05s");
	await expect
		.poll(() =>
			dialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
		)
		.toBe(true);
	await other.close();
	expect(errors).toEqual([]);
});

test("palette and radius combinations render without overflow and leave semantic colors stable", async ({
	page,
}, testInfo) => {
	test.setTimeout(90_000);
	await page.goto("/login");
	await page.getByRole("button", { name: "外观设置", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "外观", exact: true });
	for (const mode of ["浅色", "深色"]) {
		await dialog.getByRole("radio", { name: mode, exact: true }).check();
		let semanticColors: Record<string, string> | undefined;
		for (const color of COLOR_THEMES) {
			await dialog
				.getByRole("radio", { name: color.label, exact: true })
				.check();
			await expect(page.locator("html")).toHaveAttribute(
				"data-color-theme",
				color.id,
			);
			const colors = await page.evaluate(() => {
				const style = getComputedStyle(document.documentElement);
				return Object.fromEntries(
					[
						"cite",
						"survey",
						"destructive",
						"warning",
						"warning-foreground",
					].map((token) => [
						token,
						style.getPropertyValue(`--${token}`).trim(),
					]),
				);
			});
			const preview = dialog.locator(`[data-theme-preview="${color.id}"]`);
			expect(
				await preview.evaluate(
					(element) => getComputedStyle(element).backgroundColor,
				),
			).toEqual(
				await page
					.locator("body")
					.evaluate((element) => getComputedStyle(element).backgroundColor),
			);
			if (semanticColors) expect(colors).toEqual(semanticColors);
			semanticColors = colors;
			const ratios = await page.evaluate(() => {
				const canvas = document.createElement("canvas");
				canvas.width = canvas.height = 1;
				const context = canvas.getContext("2d", { willReadFrequently: true });
				if (!context) throw new Error("Missing canvas color context");
				const probe = document.createElement("span");
				document.body.append(probe);
				const luminance = (token: string) => {
					probe.style.color = `var(--${token})`;
					context.fillStyle = getComputedStyle(probe).color;
					context.fillRect(0, 0, 1, 1);
					const [r, g, b] = Array.from(context.getImageData(0, 0, 1, 1).data)
						.slice(0, 3)
						.map((value) => {
							const channel = value / 255;
							return channel <= 0.04045
								? channel / 12.92
								: ((channel + 0.055) / 1.055) ** 2.4;
						});
					return 0.2126 * r + 0.7152 * g + 0.0722 * b;
				};
				const result = [
					["foreground", "background"],
					["muted-foreground", "background"],
					["muted-foreground", "muted"],
					["primary", "background"],
					["primary-foreground", "primary"],
					["accent-foreground", "accent"],
					["sidebar-foreground", "sidebar"],
					["sidebar-accent-foreground", "sidebar-accent"],
					["evidence", "background"],
					["cite", "background"],
					["warning-foreground", "warning"],
					["destructive", "background"],
				].map(([fg, bg]) => {
					const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
					return { pair: `${fg}/${bg}`, ratio: (a + 0.05) / (b + 0.05) };
				});
				probe.remove();
				return result;
			});
			for (const result of ratios)
				expect(
					result.ratio,
					`${color.id}/${mode}: ${result.pair}`,
				).toBeGreaterThanOrEqual(4.5);
			for (const radius of ["0", "3.5", "8"]) {
				await dialog
					.getByRole("spinbutton", { name: "圆角数值", exact: true })
					.fill(radius);
				await page.keyboard.press("Tab");
				await expect(
					page.getByRole("button", {
						name: "登录",
						exact: true,
						includeHidden: true,
					}),
				).toHaveCSS("border-radius", `${radius}px`);
				await expect
					.poll(() =>
						page.evaluate(
							() => document.documentElement.scrollWidth <= innerWidth,
						),
					)
					.toBe(true);
			}
			await page.screenshot({
				path: testInfo.outputPath(`appearance-${color.id}-${mode}.png`),
				animations: "disabled",
			});
		}
	}
	await page.screenshot({
		path: testInfo.outputPath("appearance-combinations.png"),
		animations: "disabled",
	});
});

test("custom radius supports drag, keyboard, exact input and safe empty/range handling", async ({
	page,
}, info) => {
	await page.goto("/login");
	await page.getByRole("button", { name: "外观设置", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "外观", exact: true });
	const slider = dialog.getByRole("slider", { name: "圆角大小", exact: true });
	const number = dialog.getByRole("spinbutton", {
		name: "圆角数值",
		exact: true,
	});
	await number.fill("3.5");
	await number.press("Enter");
	await expect(slider).toHaveValue("3.5");
	await expect(page.locator("html")).toHaveAttribute("data-radius", "3.5");
	await number.fill("");
	await number.press("Tab");
	await expect(number).toHaveValue("3.5");
	await number.fill("99");
	await number.press("Tab");
	await expect(number).toHaveValue("12");
	await number.fill("-5");
	await number.press("Tab");
	await expect(number).toHaveValue("0");
	await slider.focus();
	await slider.press("ArrowRight");
	await expect(slider).toHaveValue("0.5");
	await slider.press("End");
	await expect(slider).toHaveValue("12");
	const box = await dialog.locator('[data-slot="slider"]').boundingBox();
	if (!box) throw new Error("Missing radius slider");
	await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + 2, box.y + box.height / 2, { steps: 8 });
	await expect(slider).toHaveValue("0");
	await expect(page.locator("html")).toHaveAttribute("data-radius", "0");
	await page.mouse.up();
	await number.fill("4.75");
	await number.press("Tab");
	await expect(slider).toHaveValue("5");
	await page.screenshot({
		path: info.outputPath("custom-radius.png"),
		animations: "disabled",
	});
	await page.keyboard.press("Escape");
	await page.reload();
	await expect(page.locator("html")).toHaveAttribute("data-radius", "5");
	await expect(
		page.getByRole("button", { name: "登录", exact: true }),
	).toHaveCSS("border-radius", "5px");
});

test("primary button text remains readable in real resting and hover states", async ({
	page,
}) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto("/login");
	const button = page.getByRole("button", { name: "登录", exact: true });
	const canHover = await page.evaluate(
		() => matchMedia("(hover: hover)").matches,
	);
	for (const theme of COLOR_THEMES) {
		for (const mode of ["浅色", "深色"]) {
			await page.getByRole("button", { name: "外观设置", exact: true }).click();
			await page.getByRole("radio", { name: theme.label, exact: true }).check();
			await page.getByRole("radio", { name: mode, exact: true }).check();
			await page.keyboard.press("Escape");
			if (canHover) await button.hover();
			const measure = () => textContrast(button);
			if (canHover)
				await expect
					.poll(async () => (await measure()).alpha)
					.toBeLessThan(255);
			expect(
				(await measure()).ratio,
				`${theme.id}/${mode}/button`,
			).toBeGreaterThanOrEqual(4.5);
		}
	}
});

test("appearance and login remain readable with 200 percent root text size", async ({
	page,
}, info) => {
	await page.goto("/login");
	await page.getByRole("button", { name: "外观设置", exact: true }).click();
	await page.evaluate(() => {
		document.documentElement.style.fontSize = "200%";
	});
	const dialog = page.getByRole("dialog", { name: "外观", exact: true });
	for (const width of [1024, 390, 320]) {
		await page.setViewportSize({ width, height: 900 });
		await expect(dialog.getByText("主题", { exact: true })).toHaveCSS(
			"font-size",
			"28px",
		);
		await expect
			.poll(() => dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
			.toBe(true);
		for (const name of ["Vercel", "Claude", "Violet Bloom"]) {
			await dialog.getByRole("radio", { name, exact: true }).check();
			const label = dialog.getByText(name, { exact: true });
			await expect
				.poll(() =>
					label.evaluate((el) => {
						const s = getComputedStyle(el);
						return (
							el.clientWidth >= parseFloat(s.fontSize) * 3 &&
							el.scrollWidth <= el.clientWidth + 1
						);
					}),
				)
				.toBe(true);
		}
		const radius = dialog.getByRole("spinbutton", {
			name: "圆角数值",
			exact: true,
		});
		await radius.fill("4.5");
		await radius.press("Enter");
		await expect(
			dialog.getByRole("slider", { name: "圆角大小", exact: true }),
		).toHaveValue("4.5");
		await dialog
			.getByRole("button", { name: "恢复默认", exact: true })
			.scrollIntoViewIfNeeded();
		await page.screenshot({
			path: info.outputPath(`appearance-text-200-${width}.png`),
			animations: "disabled",
		});
	}
	await page.keyboard.press("Escape");
	await expect(page.getByLabel("邮箱", { exact: true })).toHaveCSS(
		"font-size",
		"32px",
	);
	await expect
		.poll(() =>
			page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth + 1,
			),
		)
		.toBe(true);
	await page.screenshot({
		path: info.outputPath("login-text-200.png"),
		animations: "disabled",
		fullPage: true,
	});
});

test("invalid and blocked local storage never prevents login or appearance changes", async ({
	page,
}) => {
	await page.addInitScript(() => {
		localStorage.setItem(
			"unorag-appearance-v1",
			'{"color":"bad","radius":"url(bad)"}',
		);
	});
	await page.goto("/login");
	await expect(page.locator("html")).toHaveAttribute(
		"data-color-theme",
		"vercel",
	);
	await expect(page.locator("html")).toHaveAttribute("data-radius", "4");
	await page.addInitScript(() => {
		Object.defineProperty(window, "localStorage", {
			get() {
				throw new Error("blocked");
			},
		});
	});
	await page.reload();
	await page.getByRole("button", { name: "外观设置", exact: true }).click();
	await page
		.getByRole("dialog")
		.getByRole("radio", { name: "Violet Bloom", exact: true })
		.check();
	await expect(page.locator("html")).toHaveAttribute(
		"data-color-theme",
		"violet-bloom",
	);
	await expect(
		page.getByRole("button", {
			name: "登录",
			exact: true,
			includeHidden: true,
		}),
	).toBeEnabled();
});
