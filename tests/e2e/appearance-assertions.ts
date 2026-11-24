import { expect, type Locator } from "@playwright/test";

export async function selectAppearanceRadio(radio: Locator) {
	// The controlled value commits inside the View Transition callback.
	await radio.click();
	await expect(radio).toBeChecked();
	await radio.page().waitForFunction(() => {
		const active =
			CSS.supports("selector(:active-view-transition)") &&
			document.documentElement.matches(":active-view-transition");
		return (
			!active &&
			!document
				.getAnimations()
				.some(
					({ effect, playState, pending }) =>
						effect instanceof KeyframeEffect &&
						effect.pseudoElement?.startsWith("::view-transition") &&
						(pending || playState === "running"),
				)
		);
	});
}

export function textContrast(locator: Locator) {
	return locator.evaluate((element) => {
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 1;
		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (!context) throw new Error("Missing canvas color context");
		const style = getComputedStyle(element);
		context.fillStyle = style.backgroundColor;
		context.fillRect(0, 0, 1, 1);
		const alpha = context.getImageData(0, 0, 1, 1).data[3];
		const luminance = () => {
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
		const layers: string[] = [];
		for (
			let current: Element | null = element;
			current;
			current = current.parentElement
		) {
			layers.push(getComputedStyle(current).backgroundColor);
		}
		context.fillStyle = "#fff";
		context.fillRect(0, 0, 1, 1);
		for (const color of layers.reverse()) {
			context.fillStyle = color;
			context.fillRect(0, 0, 1, 1);
		}
		const background = luminance();
		context.fillStyle = style.color;
		context.fillRect(0, 0, 1, 1);
		const foreground = luminance();
		return {
			alpha,
			ratio:
				(Math.max(foreground, background) + 0.05) /
				(Math.min(foreground, background) + 0.05),
		};
	});
}
