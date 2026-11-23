export const COLOR_THEMES = [
	{ id: "vercel", label: "Vercel", radius: 4 },
	{ id: "modern-minimal", label: "Modern Minimal", radius: 6 },
	{ id: "claude", label: "Claude", radius: 8 },
	{ id: "violet-bloom", label: "Violet Bloom", radius: 12 },
] as const;

export const RADIUS_RANGE = { min: 0, max: 12, step: 0.5, default: 4 } as const;
export const RADIUS_QUICK_STOPS = [0, 4, 6, 8, 12] as const;

const LEGACY_RADII: Record<string, number> = { none: 0, balanced: 4, soft: 8 };

export type ColorThemeId = (typeof COLOR_THEMES)[number]["id"];
export type RadiusPreference = "preset" | number;

const THEME_RADIUS_MAP: Record<ColorThemeId, number> = {
	vercel: 4,
	"modern-minimal": 6,
	claude: 8,
	"violet-bloom": 12,
};

export function presetRadiusForTheme(color: ColorThemeId): number {
	return THEME_RADIUS_MAP[color] ?? RADIUS_RANGE.default;
}

export function normalizeRadius(value: unknown): number {
	const pixels = typeof value === "string" ? LEGACY_RADII[value] : value;
	if (typeof pixels !== "number" || !Number.isFinite(pixels))
		return RADIUS_RANGE.default;
	const bounded = Math.min(
		RADIUS_RANGE.max,
		Math.max(RADIUS_RANGE.min, pixels),
	);
	return Math.round(bounded / RADIUS_RANGE.step) * RADIUS_RANGE.step;
}

export function parseRadiusPreference(value: unknown): RadiusPreference {
	if (value === "preset") return "preset";
	const pixels = typeof value === "string" ? LEGACY_RADII[value] : value;
	if (typeof pixels !== "number" || !Number.isFinite(pixels)) return "preset";
	return normalizeRadius(pixels);
}

export type Appearance = {
	color: ColorThemeId;
	radius: RadiusPreference;
};

export function resolveRadius(appearance: Appearance): number {
	return appearance.radius === "preset"
		? presetRadiusForTheme(appearance.color)
		: appearance.radius;
}

export const APPEARANCE_STORAGE_KEY = "unorag-appearance-v1";
export const DEFAULT_APPEARANCE: Appearance = {
	color: "vercel",
	radius: "preset",
};

export function parseAppearance(raw: string | null): Appearance {
	try {
		const value: unknown = JSON.parse(raw ?? "null");
		if (!value || typeof value !== "object") return DEFAULT_APPEARANCE;
		const candidate = value as Record<string, unknown>;
		return {
			color:
				COLOR_THEMES.find((theme) => theme.id === candidate.color)?.id ??
				DEFAULT_APPEARANCE.color,
			radius: parseRadiusPreference(candidate.radius),
		};
	} catch {
		return DEFAULT_APPEARANCE;
	}
}

// Parser and bootstrap share bounds/migrations; tests check normalization parity.
export const APPEARANCE_INIT_SCRIPT = `(()=>{let a=${JSON.stringify(DEFAULT_APPEARANCE)};const b=${JSON.stringify(RADIUS_RANGE)},l=${JSON.stringify(LEGACY_RADII)},p=${JSON.stringify(THEME_RADIUS_MAP)};try{const v=JSON.parse(localStorage.getItem(${JSON.stringify(APPEARANCE_STORAGE_KEY)})||"null");if(v&&typeof v==="object"){if(Object.prototype.hasOwnProperty.call(p,v.color))a.color=v.color;if(v.radius==="preset"){a.radius="preset"}else{const r=typeof v.radius==="string"&&Object.prototype.hasOwnProperty.call(l,v.radius)?l[v.radius]:v.radius;if(typeof r==="number"&&Number.isFinite(r))a.radius=Math.round(Math.min(b.max,Math.max(b.min,r))/b.step)*b.step}}}catch{}const resolved=a.radius==="preset"?p[a.color]:a.radius;const d=document.documentElement;d.dataset.colorTheme=a.color;d.dataset.radius=String(resolved);d.dataset.radiusMode=a.radius==="preset"?"preset":"custom";d.style.setProperty("--radius",resolved+"px")})()`;
