"use server";

import { cookies } from "next/headers";
import { isLocale, LOCALE_COOKIE, type LocalePreference } from "./locale";

export async function setInterfaceLanguage(preference: LocalePreference) {
	if (!isLocale(preference) && preference !== "system") return false;
	const cookieStore = await cookies();
	cookieStore.set(LOCALE_COOKIE, preference === "system" ? "" : preference, {
		httpOnly: true,
		sameSite: "lax",
		path: "/",
		secure: process.env.NODE_ENV === "production",
		maxAge: preference === "system" ? 0 : 365 * 24 * 60 * 60,
	});
	return true;
}
