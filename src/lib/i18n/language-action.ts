"use server";

import { cookies } from "next/headers";
import { isLocale, LOCALE_COOKIE, type Locale } from "./locale";

export async function setInterfaceLanguage(locale: Locale) {
	if (!isLocale(locale)) return false;
	const cookieStore = await cookies();
	cookieStore.set(LOCALE_COOKIE, locale, {
		httpOnly: true,
		sameSite: "lax",
		path: "/",
		secure: process.env.NODE_ENV === "production",
		maxAge: 365 * 24 * 60 * 60,
	});
	return true;
}
