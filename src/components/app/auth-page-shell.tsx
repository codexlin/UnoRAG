import type { ReactNode } from "react";

import { ThemeToggle } from "@/components/app/theme-toggle";
import { UnoRAGLogo } from "@/components/app/unorag-logo";

export function AuthPageShell({ children }: { children: ReactNode }) {
	return (
		<div className="flex min-h-dvh flex-col bg-background text-sm text-foreground">
			<header className="flex min-h-20 shrink-0 flex-wrap items-center justify-between gap-4 border-b px-5 py-3 sm:px-8">
				<UnoRAGLogo size="md" withWordmark />
				<ThemeToggle />
			</header>
			<main className="flex flex-1 items-center justify-center px-5 py-10 sm:px-8 sm:py-16">
				<div className="w-full min-w-0 max-w-sm space-y-8 break-words">
					{children}
				</div>
			</main>
		</div>
	);
}
