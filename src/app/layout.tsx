import type { Metadata } from "next";

import { ThemeProvider } from "@/components/app/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { WindowScrollbar } from "@/components/ui/window-scrollbar";
import { APPEARANCE_INIT_SCRIPT } from "@/lib/appearance";
import { interfaceText } from "@/lib/i18n/locale";
import { LanguageProvider } from "@/lib/i18n/provider";
import { getRequestLanguage } from "@/lib/i18n/request-locale";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
	const t = interfaceText((await getRequestLanguage()).locale);
	return {
		title: t(
			"UnoRAG | 可治理、可核验的企业知识服务",
			"UnoRAG | Governed enterprise knowledge",
		),
		description: t(
			"私有化部署的企业知识基础设施，统一文档生命周期、权限隔离、复杂解析、检索与有据回答。",
			"Self-hosted enterprise knowledge infrastructure with document lifecycle management, access controls, parsing, and evidence-backed answers.",
		),
		icons: {
			icon: [
				{
					url: "/favicon-16x16.png",
					sizes: "16x16",
					type: "image/png",
				},
				{
					url: "/favicon-32x32.png",
					sizes: "32x32",
					type: "image/png",
				},
				{
					url: "/brand/uno-favicon.svg",
					sizes: "any",
					type: "image/svg+xml",
				},
			],
			apple: [
				{
					url: "/apple-touch-icon.png",
					sizes: "180x180",
					type: "image/png",
				},
			],
		},
	};
}

export default async function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	const language = await getRequestLanguage();
	return (
		<html
			lang={language.locale}
			suppressHydrationWarning
			className="h-full antialiased"
		>
			<body className="flex min-h-full flex-col font-sans">
				{/* Parser-executed, allow-listed bootstrap also works before hydration bundles load. */}
				<script
					id="unorag-appearance"
					// biome-ignore lint/security/noDangerouslySetInnerHtml: static bootstrap with allow-listed preferences, never user-provided script/CSS
					dangerouslySetInnerHTML={{ __html: APPEARANCE_INIT_SCRIPT }}
				/>
				<ThemeProvider
					attribute="class"
					defaultTheme="dark"
					enableSystem
					disableTransitionOnChange
					storageKey="unorag-theme"
				>
					<LanguageProvider language={language}>{children}</LanguageProvider>
					<WindowScrollbar />
					<Toaster position="top-right" richColors closeButton />
				</ThemeProvider>
			</body>
		</html>
	);
}
