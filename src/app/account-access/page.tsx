import type { Metadata } from "next";
import { Suspense } from "react";

import { AccountAccessForm } from "@/components/app/account-access-form";
import { UnoRAGLogo } from "@/components/app/unorag-logo";

export const metadata: Metadata = {
	title: "账号访问 · UnoRAG",
	referrer: "no-referrer",
	robots: { index: false, follow: false },
};

export default function AccountAccessPage() {
	return (
		<main className="grid min-h-dvh place-items-center bg-background px-6 py-10">
			<div className="w-full max-w-sm">
				<div className="mb-8 flex items-center gap-3">
					<UnoRAGLogo size="md" withWordmark />
				</div>
				<Suspense fallback={<p role="status">正在加载...</p>}>
					<AccountAccessForm />
				</Suspense>
			</div>
		</main>
	);
}
