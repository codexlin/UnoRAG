"use client";

import { createContext, type ReactNode, useContext } from "react";
import {
	DEFAULT_LOCALE,
	interfaceText,
	type Locale,
	type LocalePreference,
} from "./locale";

const LanguageContext = createContext<{
	locale: Locale;
	preference: LocalePreference;
}>({ locale: DEFAULT_LOCALE, preference: "system" });

export function LanguageProvider({
	language,
	children,
}: {
	language: { locale: Locale; preference: LocalePreference };
	children: ReactNode;
}) {
	return (
		<LanguageContext.Provider value={language}>
			{children}
		</LanguageContext.Provider>
	);
}

export function useInterfaceLanguage() {
	return useContext(LanguageContext);
}

export function useInterfaceText() {
	return interfaceText(useInterfaceLanguage().locale);
}
