import { ArrowLeft, FileQuestion } from "lucide-react";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { interfaceText } from "@/lib/i18n/locale";
import { getRequestLanguage } from "@/lib/i18n/request-locale";

export default async function NotFound() {
	const t = interfaceText((await getRequestLanguage()).locale);
	return (
		<main className="grid min-h-dvh place-items-center bg-background px-6">
			<section className="w-full max-w-md border-l-2 border-l-cite bg-card px-5 py-5">
				<div className="flex items-center gap-2 text-cite">
					<FileQuestion className="size-4" aria-hidden />
					<p className="font-mono text-xs tracking-[0.14em] uppercase">
						404 · Not found
					</p>
				</div>
				<h1 className="mt-3 text-xl font-semibold">
					{t("这个页面不存在", "Page not found")}
				</h1>
				<p className="mt-2 text-sm leading-6 text-muted-foreground">
					{t(
						"地址可能已经变更，或当前资源已被移除。",
						"The address may have changed, or the resource may have been removed.",
					)}
				</p>
				<Link
					href="/"
					className={`${buttonVariants({ variant: "outline" })} mt-5`}
				>
					<ArrowLeft data-icon="inline-start" />
					{t("返回首页", "Back to home")}
				</Link>
			</section>
		</main>
	);
}
