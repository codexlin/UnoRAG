export const LOCALE_COOKIE = "unorag-locale";
export const SUPPORTED_LOCALES = ["en", "zh-CN"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export type LocalePreference = Locale | "system";
export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(value: unknown): value is Locale {
	return value === "en" || value === "zh-CN";
}

export function resolveLocale(
	preference: string | undefined,
	acceptLanguage: string | null | undefined,
): Locale {
	if (isLocale(preference)) return preference;
	let locale = DEFAULT_LOCALE;
	let bestQuality = 0;
	for (const range of (acceptLanguage ?? "").split(",")) {
		const match =
			/^([a-z]{2,8})(?:-[a-z0-9]{1,8})*(?:\s*;\s*q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?$/i.exec(
				range.trim(),
			);
		if (!match) continue;
		const language = match[1].toLowerCase();
		const quality = Number(match[2] ?? 1);
		if ((language === "en" || language === "zh") && quality > bestQuality) {
			locale = language === "zh" ? "zh-CN" : "en";
			bestQuality = quality;
		}
	}
	return locale;
}

/** Choose interface-owned copy only, never user content or API values. */
export function interfaceText(locale: Locale) {
	return translators[locale];
}

const translators: Record<Locale, (zh: string, en: string) => string> = {
	en: (_, en) => en,
	"zh-CN": (zh) => zh,
};
