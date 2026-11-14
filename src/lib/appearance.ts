export const COLOR_THEMES = [
	{ id: "vercel", label: "Vercel" },
	{ id: "claude", label: "Claude" },
	{ id: "violet-bloom", label: "Violet Bloom" },
] as const;

export const RADIUS_RANGE = { min: 0, max: 8, step: 0.5, default: 4 } as const;

const LEGACY_RADII: Record<string, number> = { none: 0, balanced: 4, soft: 8 };

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

export type Appearance = {
	color: (typeof COLOR_THEMES)[number]["id"];
	radius: number;
};

export const APPEARANCE_STORAGE_KEY = "unorag-appearance-v1";
export const DEFAULT_APPEARANCE: Appearance = {
	color: "vercel",
	radius: RADIUS_RANGE.default,
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
			radius: normalizeRadius(candidate.radius),
		};
	} catch {
		return DEFAULT_APPEARANCE;
	}
}

// Parser and bootstrap share bounds/migrations; tests check normalization parity.
export const APPEARANCE_INIT_SCRIPT = `(()=>{let a=${JSON.stringify(DEFAULT_APPEARANCE)};const b=${JSON.stringify(RADIUS_RANGE)},l=${JSON.stringify(LEGACY_RADII)};try{const v=JSON.parse(localStorage.getItem(${JSON.stringify(APPEARANCE_STORAGE_KEY)})||"null");if(v&&typeof v==="object"){if(${JSON.stringify(COLOR_THEMES.map((theme) => theme.id))}.includes(v.color))a.color=v.color;const r=typeof v.radius==="string"?l[v.radius]:v.radius;if(typeof r==="number"&&Number.isFinite(r))a.radius=Math.round(Math.min(b.max,Math.max(b.min,r))/b.step)*b.step}}catch{}const d=document.documentElement;d.dataset.colorTheme=a.color;d.dataset.radius=String(a.radius);d.style.setProperty("--radius",a.radius+"px")})()`;
