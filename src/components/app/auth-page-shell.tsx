import Link from "next/link";
import type { ReactNode } from "react";

import { AuthBrandStage } from "@/components/app/auth-brand-stage";
import { LanguageMenu } from "@/components/app/language-menu";
import { SpotlightCard } from "@/components/app/spotlight-card";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { UnoRAGLogo } from "@/components/app/unorag-logo";

export function AuthPageShell({ children }: { children: ReactNode }) {
	return (
		<div className="flex min-h-dvh flex-col bg-background text-sm text-foreground">
			<header className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-4 border-b border-border bg-background px-4 py-2 sm:px-8">
				<Link
					href="/"
					className="inline-flex min-h-11 items-center rounded-md px-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
				>
					<UnoRAGLogo size="sm" withWordmark />
				</Link>
				<div className="flex items-center gap-1 [&_button]:size-11">
					<LanguageMenu />
					<ThemeToggle />
				</div>
			</header>
			<main className="grid flex-1 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)]">
				<AuthBrandStage />
				<div className="flex min-w-0 items-center justify-center bg-muted/25 px-4 py-8 sm:px-8 sm:py-12 dark:bg-background lg:bg-background lg:px-10 xl:px-14">
					<SpotlightCard className="w-full min-w-0 max-w-[420px]">
						<div className="min-w-0 space-y-6 break-words">{children}</div>
					</SpotlightCard>
				</div>
			</main>
		</div>
	);
}
