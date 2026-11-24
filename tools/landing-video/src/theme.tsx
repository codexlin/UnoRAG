import React from "react";
import {
	AbsoluteFill,
	Easing,
	Img,
	interpolate,
	spring,
	staticFile,
} from "remotion";

export type FilmLocale = "zh-CN" | "en";
export type FilmTheme = "light" | "dark";

export type FilmProps = {
	locale: FilmLocale;
	theme: FilmTheme;
};

export type FilmPalette = {
	bg: string;
	bg2: string;
	sidebar: string;
	card: string;
	mutedBg: string;
	border: string;
	borderSubtle: string;
	fg: string;
	mutedFg: string;
	dimFg: string;
	primary: string;
	primaryFg: string;
	cite: string;
	citeBg: string;
	citeBorder: string;
	citeSolidFg: string;
	evidence: string;
	evidenceBg: string;
	evidenceBorder: string;
	warning: string;
	warningBg: string;
	warningBorder: string;
	gridLine: string;
	shadow: string;
	shadowSm: string;
};

export const FONT_SANS =
	'"Geist", "PingFang SC", "Noto Sans CJK SC", "Maple Mono NF CN", "Droid Sans Fallback", system-ui, -apple-system, sans-serif';
export const FONT_MONO =
	'"Geist Mono", "Maple Mono NF CN", "JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace';

export const EASE = {
	out: Easing.bezier(0.22, 1, 0.36, 1),
	snappy: Easing.bezier(0.16, 1, 0.3, 1),
	swift: Easing.bezier(0.4, 0, 0.2, 1),
	overshoot: Easing.bezier(0.34, 1.38, 0.44, 1),
	drop: Easing.bezier(0.5, 0, 0.8, 0.75),
} as const;

export const clamp = {
	extrapolateLeft: "clamp" as const,
	extrapolateRight: "clamp" as const,
};

export const ramp = (
	frame: number,
	start: number,
	dur: number,
	easing: (t: number) => number = EASE.out,
) =>
	interpolate(frame, [start, start + Math.max(1, dur)], [0, 1], {
		...clamp,
		easing,
	});

export const mix = (a: number, b: number, t: number) => a + (b - a) * t;

export const springAt = (
	frame: number,
	start: number,
	config = { damping: 16, stiffness: 210, mass: 0.9 },
) => {
	if (frame < start) return 0;
	return spring({ frame: frame - start, fps: 30, config });
};

export function alpha(hex: string, opacity: number): string {
	const clean = hex.replace("#", "");
	const r = Number.parseInt(clean.slice(0, 2), 16);
	const g = Number.parseInt(clean.slice(2, 4), 16);
	const b = Number.parseInt(clean.slice(4, 6), 16);
	return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, opacity)).toFixed(3)})`;
}

export function getPalette(theme: FilmTheme): FilmPalette {
	if (theme === "dark") {
		return {
			bg: "#09090b",
			bg2: "#0e0e12",
			sidebar: "#111114",
			card: "#141418",
			mutedBg: "#1b1b21",
			border: "#27272e",
			borderSubtle: "#1f1f26",
			fg: "#fafafa",
			mutedFg: "#a1a1aa",
			dimFg: "#71717a",
			primary: "#fafafa",
			primaryFg: "#09090b",
			cite: "#8dcdab",
			citeBg: "rgba(141, 205, 171, 0.13)",
			citeBorder: "rgba(141, 205, 171, 0.34)",
			citeSolidFg: "#061a11",
			evidence: "#93c5fd",
			evidenceBg: "rgba(147, 197, 253, 0.13)",
			evidenceBorder: "rgba(147, 197, 253, 0.36)",
			warning: "#edcb91",
			warningBg: "rgba(237, 203, 145, 0.12)",
			warningBorder: "rgba(237, 203, 145, 0.32)",
			gridLine: "rgba(255, 255, 255, 0.04)",
			shadow:
				"0 22px 54px -18px rgba(0, 0, 0, 0.78), 0 0 0 1px rgba(255, 255, 255, 0.04)",
			shadowSm: "0 8px 20px -8px rgba(0, 0, 0, 0.56)",
		};
	}
	return {
		bg: "#fafafa",
		bg2: "#f3f4f6",
		sidebar: "#f4f4f6",
		card: "#ffffff",
		mutedBg: "#f4f4f6",
		border: "#e4e4e8",
		borderSubtle: "#ededf1",
		fg: "#09090b",
		mutedFg: "#52525b",
		dimFg: "#71717a",
		primary: "#09090b",
		primaryFg: "#ffffff",
		cite: "#28734c",
		citeBg: "rgba(40, 115, 76, 0.09)",
		citeBorder: "rgba(40, 115, 76, 0.30)",
		citeSolidFg: "#ffffff",
		evidence: "#1d4ed8",
		evidenceBg: "rgba(29, 78, 216, 0.08)",
		evidenceBorder: "rgba(29, 78, 216, 0.28)",
		warning: "#795014",
		warningBg: "#fcf3df",
		warningBorder: "rgba(121, 80, 20, 0.26)",
		gridLine: "rgba(9, 9, 11, 0.042)",
		shadow:
			"0 18px 42px -16px rgba(9, 9, 11, 0.11), 0 2px 6px rgba(9, 9, 11, 0.04)",
		shadowSm: "0 4px 14px -4px rgba(9, 9, 11, 0.07)",
	};
}

export function pickText(locale: FilmLocale, zh: string, en: string): string {
	return locale === "zh-CN" ? zh : en;
}

/** Bundled local variable Geist & Geist Mono — zero CDN requests, crisp rendering. */
export const FilmFonts: React.FC = () => (
	<style>{`
		@font-face {
			font-family: 'Geist';
			src: url('${staticFile("fonts/geist-latin-wght-normal.woff2")}') format('woff2');
			font-weight: 100 900;
			font-style: normal;
			font-display: block;
		}
		@font-face {
			font-family: 'Geist Mono';
			src: url('${staticFile("fonts/geist-mono-latin-wght-normal.woff2")}') format('woff2');
			font-weight: 100 900;
			font-style: normal;
			font-display: block;
		}
	`}</style>
);

/** Official pure-vector UnoMark (zero glow, zero gradient, zero shadow per uno-brand-system.md). */
export const UnoMarkImg: React.FC<{ theme: FilmTheme; size?: number }> = ({
	theme,
	size = 22,
}) => (
	<Img
		src={staticFile(theme === "dark" ? "uno-mark-white.svg" : "uno-mark.svg")}
		style={{ width: size, height: size, display: "block", flexShrink: 0 }}
	/>
);

/** Restrained Swiss studio backdrop with architectural grid and subtle directional tone. */
export const SwissStage: React.FC<{
	theme: FilmTheme;
	palette: FilmPalette;
	gridSize?: number;
}> = ({ theme, palette, gridSize = 48 }) => (
	<>
		<AbsoluteFill
			style={{
				background:
					theme === "dark"
						? `radial-gradient(ellipse 75% 65% at 50% 0%, rgba(141, 205, 171, 0.06) 0%, ${palette.bg} 66%, #050507 100%)`
						: `radial-gradient(ellipse 78% 66% at 50% 0%, #ffffff 0%, ${palette.bg} 56%, ${palette.bg2} 100%)`,
				pointerEvents: "none",
			}}
		/>
		<AbsoluteFill
			style={{
				backgroundImage: `linear-gradient(to right, ${palette.gridLine} 1px, transparent 1px), linear-gradient(to bottom, ${palette.gridLine} 1px, transparent 1px)`,
				backgroundSize: `${gridSize}px ${gridSize}px`,
				pointerEvents: "none",
			}}
		/>
	</>
);

/** Subtle tactile grain (strictly within Swiss restraint). */
export const FilmGrain: React.FC<{ opacity?: number }> = ({
	opacity = 0.025,
}) => (
	<AbsoluteFill
		style={{
			opacity,
			pointerEvents: "none",
			backgroundImage:
				"url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
			mixBlendMode: "overlay",
		}}
	/>
);

/** Shotcraft spring-locking precision corner brackets around any target rectangle. */
export const CornerBrackets: React.FC<{
	x: number;
	y: number;
	w: number;
	h: number;
	frame: number;
	fireAt: number;
	color: string;
	armLen?: number;
}> = ({ x, y, w, h, frame, fireAt, color, armLen = 22 }) => {
	const f = frame - fireAt;
	if (f < 0) return null;
	const s = springAt(frame, fireAt, { damping: 16, stiffness: 220, mass: 0.9 });
	const pad = 28 * (1 - s);
	const op = Math.min(1, f / 3);
	const arm = armLen + 8 * (1 - ramp(frame, fireAt + 2, 10, EASE.out));
	const flash =
		ramp(frame, fireAt + 2, 3, EASE.out) *
		(1 - ramp(frame, fireAt + 5, 11, EASE.out));
	const bx = x - pad;
	const by = y - pad;
	const bw = w + pad * 2;
	const bh = h + pad * 2;

	return (
		<>
			<div
				style={{
					position: "absolute",
					left: x,
					top: y,
					width: w,
					height: h,
					borderRadius: 6,
					background: alpha(color, 0.07 * flash),
					boxShadow: `inset 0 0 0 1.5px ${alpha(color, 0.42 * flash)}`,
					pointerEvents: "none",
				}}
			/>
			<svg
				width={1440}
				height={810}
				style={{
					position: "absolute",
					left: 0,
					top: 0,
					overflow: "visible",
					opacity: op,
					pointerEvents: "none",
				}}
			>
				<path
					d={[
						`M${bx} ${by + arm}V${by}H${bx + arm}`,
						`M${bx + bw - arm} ${by}H${bx + bw}V${by + arm}`,
						`M${bx + bw} ${by + bh - arm}V${by + bh}H${bx + bw - arm}`,
						`M${bx + arm} ${by + bh}H${bx}V${by + bh - arm}`,
					].join("")}
					fill="none"
					stroke={color}
					strokeWidth={2.75}
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</svg>
		</>
	);
};
