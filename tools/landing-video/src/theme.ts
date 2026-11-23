export type FilmLocale = "zh-CN" | "en";
export type FilmTheme = "light" | "dark";

export type FilmProps = {
	locale: FilmLocale;
	theme: FilmTheme;
};

export type FilmPalette = {
	bg: string;
	sidebar: string;
	card: string;
	mutedBg: string;
	border: string;
	borderSubtle: string;
	fg: string;
	mutedFg: string;
	primary: string;
	primaryFg: string;
	cite: string;
	citeBg: string;
	citeBorder: string;
	evidence: string;
	evidenceBg: string;
	evidenceBorder: string;
	warning: string;
	warningBg: string;
	gridLine: string;
	shadow: string;
	shadowSm: string;
};

export const FONT_SANS =
	'"Geist", "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", "Droid Sans Fallback", system-ui, -apple-system, sans-serif';
export const FONT_MONO =
	'"Geist Mono", "Maple Mono NF CN", "JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace';

export function getPalette(theme: FilmTheme): FilmPalette {
	if (theme === "dark") {
		return {
			bg: "#09090b",
			sidebar: "#111114",
			card: "#141418",
			mutedBg: "#1c1c22",
			border: "#27272e",
			borderSubtle: "#1f1f26",
			fg: "#fafafa",
			mutedFg: "#a1a1aa",
			primary: "#fafafa",
			primaryFg: "#09090b",
			cite: "#8dcdab",
			citeBg: "rgba(141, 205, 171, 0.12)",
			citeBorder: "rgba(141, 205, 171, 0.32)",
			evidence: "#93c5fd",
			evidenceBg: "rgba(147, 197, 253, 0.12)",
			evidenceBorder: "rgba(147, 197, 253, 0.34)",
			warning: "#edcb91",
			warningBg: "rgba(237, 203, 145, 0.12)",
			gridLine: "rgba(255, 255, 255, 0.045)",
			shadow: "0 18px 44px -16px rgba(0, 0, 0, 0.72)",
			shadowSm: "0 4px 14px -4px rgba(0, 0, 0, 0.5)",
		};
	}
	return {
		bg: "#fafafa",
		sidebar: "#f4f4f6",
		card: "#ffffff",
		mutedBg: "#f2f2f5",
		border: "#e4e4e8",
		borderSubtle: "#ededf0",
		fg: "#09090b",
		mutedFg: "#52525b",
		primary: "#09090b",
		primaryFg: "#ffffff",
		cite: "#28734c",
		citeBg: "rgba(40, 115, 76, 0.09)",
		citeBorder: "rgba(40, 115, 76, 0.28)",
		evidence: "#1d4ed8",
		evidenceBg: "rgba(29, 78, 216, 0.08)",
		evidenceBorder: "rgba(29, 78, 216, 0.26)",
		warning: "#88601b",
		warningBg: "#fcf3df",
		gridLine: "rgba(9, 9, 11, 0.045)",
		shadow: "0 14px 36px -14px rgba(9, 9, 11, 0.10)",
		shadowSm: "0 2px 10px -3px rgba(9, 9, 11, 0.07)",
	};
}

export function pickText(locale: FilmLocale, zh: string, en: string): string {
	return locale === "zh-CN" ? zh : en;
}
