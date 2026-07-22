"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { APP_NAV_ITEMS } from "@/components/app/nav-items";
import { cn } from "@/lib/utils";

export function AppSidebar() {
	const pathname = usePathname();

	return (
		<aside className="flex w-[232px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar/90 backdrop-blur-sm">
			<div className="flex h-14 items-center gap-2.5 border-b border-sidebar-border px-4">
				<Link href="/" className="group flex min-w-0 items-baseline gap-2">
					<span className="font-heading text-lg font-semibold tracking-tight text-primary transition-colors group-hover:text-foreground">
						MeriKnow
					</span>
					<span className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
						desk
					</span>
				</Link>
			</div>

			<nav className="flex flex-1 flex-col gap-1 p-3" aria-label="工作台导航">
				{APP_NAV_ITEMS.map((item) => {
					const active =
						pathname === item.href || pathname.startsWith(`${item.href}/`);
					const Icon = item.icon;
					return (
						<Link
							key={item.href}
							href={item.href}
							className={cn(
								"group flex items-start gap-3 rounded-md border border-transparent px-2.5 py-2.5 transition-colors",
								active
									? "border-border bg-card text-foreground shadow-sm"
									: "text-muted-foreground hover:border-border/70 hover:bg-card/60 hover:text-foreground",
							)}
						>
							<span
								className={cn(
									"mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border",
									active
										? "border-primary/25 bg-primary/10 text-primary"
										: "border-border/80 bg-background/60 text-muted-foreground group-hover:text-foreground",
								)}
							>
								<Icon className="size-4" aria-hidden />
							</span>
							<span className="min-w-0">
								<span className="flex items-center gap-2">
									<span className="font-mono text-[10px] tracking-wider text-muted-foreground">
										{item.code}
									</span>
									<span className="text-sm font-medium text-foreground">
										{item.label}
									</span>
								</span>
								<span className="mt-0.5 block truncate text-xs text-muted-foreground">
									{item.hint}
								</span>
							</span>
							{active ? (
								<span
									className="ml-auto mt-1 h-8 w-0.5 shrink-0 rounded-full bg-cite"
									aria-hidden
								/>
							) : null}
						</Link>
					);
				})}
			</nav>

			<div className="border-t border-sidebar-border p-3">
				<p className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
					Workspace
				</p>
				<p className="mt-1 truncate text-sm font-medium text-foreground">
					默认工作区
				</p>
				<p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
					mock · Phase 1
				</p>
			</div>
		</aside>
	);
}
