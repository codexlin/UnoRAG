"use client";

import { createContext, type ReactNode, useContext } from "react";
import { DEFAULT_LOCALE, interfaceText, type Locale } from "./locale";

const LanguageContext = createContext<{ locale: Locale }>({
	locale: DEFAULT_LOCALE,
});

export function LanguageProvider({
	language,
	children,
}: {
	language: { locale: Locale };
	children?: ReactNode;
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
