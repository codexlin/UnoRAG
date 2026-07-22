"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { getAppNavItem } from "@/components/app/nav-items";
import { fetchHealth } from "@/lib/api";
import { cn } from "@/lib/utils";

type ApiStatus = "checking" | "online" | "offline";

export function AppTopbar() {
	const pathname = usePathname();
	const current = getAppNavItem(pathname);
	const [apiStatus, setApiStatus] = useState<ApiStatus>("checking");
	const [modeLabel, setModeLabel] = useState<string | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		let cancelled = false;

		async function probe() {
			try {
				const health = await fetchHealth(controller.signal);
				if (cancelled) return;
				setApiStatus(health.status === "ok" ? "online" : "offline");
				const effective = health.effective_mode || health.ask_mode;
				setModeLabel(health.degraded ? `${effective}·降级` : effective);
			} catch {
				if (cancelled) return;
				setApiStatus("offline");
				setModeLabel(null);
			}
		}

		void probe();
		const timer = window.setInterval(() => {
			void probe();
		}, 15000);

		return () => {
			cancelled = true;
			controller.abort();
			window.clearInterval(timer);
		};
	}, []);

	const statusLabel =
		apiStatus === "online"
			? `API · ${modeLabel ?? "ok"}`
			: apiStatus === "checking"
				? "API 探测中"
				: "API 离线";

	return (
		<header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border/80 bg-card/75 px-5 backdrop-blur-sm">
			<div className="min-w-0">
				<p className="font-mono text-[10px] tracking-[0.18em] text-cite uppercase">
					{current.code} · {current.label}
				</p>
				<p className="truncate text-sm text-muted-foreground">{current.hint}</p>
			</div>
			<div className="flex items-center gap-3">
				<span className="hidden items-center gap-1.5 rounded-md border border-border/80 bg-background/70 px-2.5 py-1 font-mono text-[11px] text-muted-foreground sm:inline-flex">
					<span
						className={cn(
							"size-1.5 rounded-full",
							apiStatus === "online" && "bg-cite",
							apiStatus === "checking" && "bg-survey",
							apiStatus === "offline" && "bg-destructive",
						)}
						aria-hidden
					/>
					{statusLabel}
				</span>
				<span className="flex size-8 items-center justify-center rounded-md border border-border bg-background font-mono text-[11px] font-medium text-primary">
					MK
				</span>
			</div>
		</header>
	);
}
