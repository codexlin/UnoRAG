"use client";

import { usePathname } from "next/navigation";
import { LanguageMenu } from "@/components/app/language-menu";
import { getAppNavItem } from "@/components/app/nav-items";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useHealth } from "@/hooks/use-health";
import { formatDateTime, formatDurationMs } from "@/lib/format";
import { useInterfaceText } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

export function AppTopbar() {
	const t = useInterfaceText();
	const pathname = usePathname();
	const current = getAppNavItem(pathname);
	const { apiReady, loading, healthProbedAt, healthProbeMs } = useHealth();

	const apiStatus = loading ? "checking" : apiReady ? "online" : "offline";

	return (
		<header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b bg-background px-3 sm:px-5">
			<div className="flex min-w-0 items-center gap-2">
				<SidebarTrigger className="-ml-0.5 size-11" />
				<div className="min-w-0">
					<h1 className="text-sm font-medium text-foreground">
						{t(...current.label)}
					</h1>
				</div>
			</div>
			<div className="flex min-w-0 items-center gap-2 sm:gap-3">
				<div className="hidden flex-col items-end gap-0.5 md:flex">
					<span className="inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-background/80 px-2.5 py-1 font-mono text-xs text-muted-foreground">
						<span
							className={cn(
								"size-1.5 rounded-full transition-colors",
								apiStatus === "online" && "bg-cite",
								apiStatus === "checking" && "bg-survey",
								apiStatus === "offline" && "bg-destructive",
							)}
							aria-hidden
						/>
						{apiStatus === "checking"
							? t("知识服务检查中", "Checking knowledge service")
							: apiStatus === "online"
								? t("知识服务在线", "Knowledge service online")
								: t("知识服务不可用", "Knowledge service unavailable")}
					</span>
					{(healthProbedAt || healthProbeMs != null) && (
						<span className="text-xs font-mono text-muted-foreground">
							{t("探测", "Checked")} {formatDateTime(healthProbedAt)}
							{healthProbeMs != null
								? ` · ${formatDurationMs(healthProbeMs)}`
								: ""}
						</span>
					)}
				</div>
				<LanguageMenu />
				<ThemeToggle />
			</div>
		</header>
	);
}
