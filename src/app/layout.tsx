import type { Metadata } from "next";

import { ThemeProvider } from "@/components/app/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

export const metadata: Metadata = {
	title: "UnoRAG | 可治理、可核验的企业知识服务",
	description:
		"私有化部署的企业知识基础设施，统一文档生命周期、权限隔离、复杂解析、检索与有据回答。",
	icons: {
		icon: [
			{
				url: "/favicon-32x32.png",
				sizes: "32x32",
				type: "image/png",
			},
			{
				url: "/brand/uno-mark.svg",
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

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="zh-CN" suppressHydrationWarning className="h-full antialiased">
			<body className="flex min-h-full flex-col font-sans">
				<ThemeProvider
					attribute="class"
					defaultTheme="system"
					enableSystem
					disableTransitionOnChange
					storageKey="unorag-theme"
				>
					{children}
					<Toaster position="top-right" richColors closeButton />
				</ThemeProvider>
			</body>
		</html>
	);
}
