import "server-only";

import { cookies, headers } from "next/headers";
import { cache } from "react";
import { LOCALE_COOKIE, resolveLocale } from "./locale";

export const getRequestLanguage = cache(async () => {
	const [cookieStore, requestHeaders] = await Promise.all([
		cookies(),
		headers(),
	]);
	const value = cookieStore.get(LOCALE_COOKIE)?.value;
	return {
		locale: resolveLocale(value, requestHeaders.get("accept-language")),
	};
});
