import { expect, test } from "@playwright/test";
import { buttonVariants } from "../../src/components/ui/button";
import { COLOR_THEMES } from "../../src/lib/appearance";
import { selectAppearanceRadio, textContrast } from "./appearance-assertions";

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
	await selectAppearanceRadio(
		dialog.getByRole("radio", { name: "Claude", exact: true }),
	);
	await dialog.getByRole("slider", { name: "圆角大小", exact: true }).focus();
	await page.keyboard.press("End");
	await selectAppearanceRadio(
		dialog.getByRole("radio", { name: "深色", exact: true }),
	);
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
	await selectAppearanceRadio(
		dialog.getByRole("radio", { name: "跟随系统", exact: true }),
	);
	await expect(page.locator("html")).not.toHaveClass(/dark/);
	await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
	await expect(page.locator("html")).toHaveClass(/dark/);
	await expect(dialog).toHaveCSS("transition-property", "none");
	await expect(dialog).toHaveCSS("animation-name", "none");
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
		await selectAppearanceRadio(
			dialog.getByRole("radio", { name: mode, exact: true }),
		);
		await expect(page.locator("html")).toHaveClass(
			mode === "深色" ? /\bdark\b/ : /\blight\b/,
		);
		let semanticColors: Record<string, string> | undefined;
		for (const color of COLOR_THEMES) {
			await selectAppearanceRadio(
				dialog.getByRole("radio", { name: color.label, exact: true }),
			);
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
				const luminance = (token: string, evidenceTint = false) => {
					probe.style.color = `var(--${token})`;
					context.fillStyle = getComputedStyle(probe).color;
					context.fillRect(0, 0, 1, 1);
					if (evidenceTint) {
						probe.style.color =
							"color-mix(in oklab, var(--evidence) 15%, transparent)";
						context.fillStyle = getComputedStyle(probe).color;
						context.fillRect(0, 0, 1, 1);
					}
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
					["card-foreground", "card"],
					["popover-foreground", "popover"],
					["muted-foreground", "background"],
					["muted-foreground", "muted"],
					["muted-foreground", "card"],
					["muted-foreground", "popover"],
					["primary", "background"],
					["primary-foreground", "primary"],
					["secondary-foreground", "secondary"],
					["accent-foreground", "accent"],
					["sidebar-foreground", "sidebar"],
					["sidebar-primary-foreground", "sidebar-primary"],
					["sidebar-accent-foreground", "sidebar-accent"],
					["evidence", "background"],
					["evidence", "card"],
					["evidence-foreground", "evidence"],
					["cite", "background"],
					["warning-foreground", "warning"],
					["destructive", "background"],
				].map(([fg, bg]) => {
					const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
					return { pair: `${fg}/${bg}`, ratio: (a + 0.05) / (b + 0.05) };
				});
				const evidence = luminance("evidence");
				for (const surface of ["background", "card", "popover"]) {
					const [a, b] = [evidence, luminance(surface, true)].sort(
						(x, y) => y - x,
					);
					result.push({
						pair: `evidence/evidence tint over ${surface}`,
						ratio: (a + 0.05) / (b + 0.05),
					});
				}
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

test("Claude dark popovers keep tinted evidence and destructive actions readable", async ({
	page,
}) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.addInitScript(() => {
		localStorage.setItem(
			"unorag-appearance-v1",
			JSON.stringify({ color: "claude", radius: "preset" }),
		);
		localStorage.setItem("unorag-theme", "dark");
	});
	await page.goto("/login");
	await expect(page.locator("html")).toHaveAttribute(
		"data-color-theme",
		"claude",
	);
	await expect(page.locator("html")).toHaveClass(/\bdark\b/);
	// Exercise the shared destructive variant on the same surface as the member-removal footer.
	await page.evaluate(
		(buttonClass) => {
			const popover = document.createElement("div");
			popover.className = "fixed top-4 left-4 z-50 bg-popover p-4";
			const evidence = document.createElement("span");
			evidence.className = "bg-evidence/15 text-evidence";
			evidence.textContent = "Evidence contrast";
			const footer = document.createElement("div");
			footer.className = "bg-muted/50 p-4";
			const button = document.createElement("button");
			button.className = buttonClass;
			button.textContent = "Destructive contrast";
			footer.append(button);
			popover.append(evidence, footer);
			document.body.append(popover);
		},
		buttonVariants({ variant: "destructive" }),
	);
	const button = page.getByRole("button", { name: "Destructive contrast" });
	expect(
		(await textContrast(page.getByText("Evidence contrast"))).ratio,
	).toBeGreaterThanOrEqual(4.5);
	const resting = await textContrast(button);
	expect(resting.ratio).toBeGreaterThanOrEqual(4.5);
	if (await page.evaluate(() => matchMedia("(hover: hover)").matches)) {
		await button.hover();
		const hovered = await textContrast(button);
		expect(hovered.alpha).not.toBe(resting.alpha);
		expect(hovered.ratio).toBeGreaterThanOrEqual(4.5);
	}
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
			await selectAppearanceRadio(
				page.getByRole("radio", { name: theme.label, exact: true }),
			);
			await selectAppearanceRadio(
				page.getByRole("radio", { name: mode, exact: true }),
			);
			await page.keyboard.press("Escape");
			await expect(page.locator("html")).toHaveAttribute(
				"data-color-theme",
				theme.id,
			);
			await expect(page.locator("html")).toHaveClass(
				mode === "深色" ? /\bdark\b/ : /\blight\b/,
			);
			await page.mouse.move(0, 0);
			const measure = () => textContrast(button);
			expect(
				(await measure()).ratio,
				`${theme.id}/${mode}/button resting`,
			).toBeGreaterThanOrEqual(4.5);
			if (canHover) {
				await button.hover();
				await expect
					.poll(async () => (await measure()).alpha)
					.toBeLessThan(255);
				expect(
					(await measure()).ratio,
					`${theme.id}/${mode}/button hover`,
				).toBeGreaterThanOrEqual(4.5);
			}
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
		for (const { label: name } of COLOR_THEMES) {
			await selectAppearanceRadio(
				dialog.getByRole("radio", { name, exact: true }),
			);
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
	await selectAppearanceRadio(
		page
			.getByRole("dialog")
			.getByRole("radio", { name: "Violet Bloom", exact: true }),
	);
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
