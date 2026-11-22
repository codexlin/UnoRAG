import type { Metadata } from "next";
import { Suspense } from "react";

import { AccountAccessForm } from "@/components/app/account-access-form";
import { AuthPageShell } from "@/components/app/auth-page-shell";
import { interfaceText } from "@/lib/i18n/locale";
import { getRequestLanguage } from "@/lib/i18n/request-locale";

export async function generateMetadata(): Promise<Metadata> {
	const t = interfaceText((await getRequestLanguage()).locale);
	return {
		title: t("账号访问 · UnoRAG", "Account access · UnoRAG"),
		referrer: "no-referrer",
		robots: { index: false, follow: false },
	};
}

export default async function AccountAccessPage() {
	const t = interfaceText((await getRequestLanguage()).locale);
	return (
		<AuthPageShell>
			<Suspense
				fallback={
					<p
						className="min-h-80 text-sm leading-6 text-muted-foreground"
						role="status"
					>
						{t("正在加载...", "Loading…")}
					</p>
				}
			>
				<AccountAccessForm />
			</Suspense>
		</AuthPageShell>
	);
}
