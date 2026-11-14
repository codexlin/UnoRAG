import type { Metadata } from "next";
import { Suspense } from "react";

import { AccountAccessForm } from "@/components/app/account-access-form";
import { AuthPageShell } from "@/components/app/auth-page-shell";

export const metadata: Metadata = {
	title: "账号访问 · UnoRAG",
	referrer: "no-referrer",
	robots: { index: false, follow: false },
};

export default function AccountAccessPage() {
	return (
		<AuthPageShell>
			<Suspense
				fallback={
					<p
						className="min-h-80 text-sm leading-6 text-muted-foreground"
						role="status"
					>
						正在加载...
					</p>
				}
			>
				<AccountAccessForm />
			</Suspense>
		</AuthPageShell>
	);
}
