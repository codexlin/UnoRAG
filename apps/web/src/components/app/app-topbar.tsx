"use client";

import { usePathname } from "next/navigation";
import { getAppNavItem } from "@/components/app/nav-items";
import { useHealth } from "@/hooks/use-health";
import { formatDateTime, formatDurationMs } from "@/lib/format";
import { cn } from "@/lib/utils";

export function AppTopbar() {
	const pathname = usePathname();
	const current = getAppNavItem(pathname);
	const { health, apiReady, loading, healthProbedAt, healthProbeMs } =
		useHealth();

	const apiStatus = loading ? "checking" : apiReady ? "online" : "offline";

	const bits: string[] = [];
	if (health) {
		bits.push(health.effective_mode || health.ask_mode);
		if (health.hybrid_enabled) bits.push("hybrid");
		if (health.qdrant_ok) bits.push("qdrant");
		if (health.metadata_backend) bits.push(health.metadata_backend);
		if (!apiReady) bits.push("不可用");
	}

	return (
		<header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border/80 bg-card/80 px-5 backdrop-blur-md">
			<div className="min-w-0">
				<p className="font-mono text-[10px] tracking-[0.18em] text-cite uppercase">
					{current.code} · {current.label}
				</p>
				<p className="truncate text-sm text-muted-foreground">{current.hint}</p>
			</div>
			<div className="flex min-w-0 items-center gap-2 sm:gap-3">
				<div className="hidden flex-col items-end gap-0.5 md:flex">
					<span className="inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-background/80 px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
						<span
							className={cn(
								"size-1.5 rounded-full transition-colors",
								apiStatus === "online" &&
									"bg-cite shadow-[0_0_0_3px_color-mix(in_oklab,var(--cite)_25%,transparent)]",
								apiStatus === "checking" && "animate-pulse bg-survey",
								apiStatus === "offline" && "bg-destructive",
							)}
							aria-hidden
						/>
						{apiStatus === "checking"
							? "API 探测中"
							: apiStatus === "online"
								? `API · ${bits.join(" · ") || "ok"}`
								: `API 离线${bits.length ? ` · ${bits.join(" · ")}` : ""}`}
					</span>
					{(healthProbedAt || healthProbeMs != null) && (
						<span className="font-mono text-[10px] text-muted-foreground/80">
							探测 {formatDateTime(healthProbedAt)}
							{healthProbeMs != null
								? ` · ${formatDurationMs(healthProbeMs)}`
								: ""}
						</span>
					)}
				</div>
				<span className="flex size-8 items-center justify-center rounded-md border border-border bg-background font-mono text-[11px] font-medium text-primary transition-colors hover:border-primary/40">
					MK
				</span>
			</div>
		</header>
	);
}
