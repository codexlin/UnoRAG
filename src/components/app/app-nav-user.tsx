"use client";

import { ChevronsUpDown, LogOut, Settings2 } from "lucide-react";
import Link from "next/link";

import { useSession } from "@/components/app/session-provider";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from "@/components/ui/sidebar";
import { useHealth } from "@/hooks/use-health";
import { formatReleaseVersion } from "@/lib/release-info";
import { roleLabel } from "@/lib/session-types";
import { cn } from "@/lib/utils";

function initialsFor(name: string, email: string | null): string {
	const base = name.trim() || email?.trim() || "?";
	const parts = base.split(/\s+/).filter(Boolean);
	const first = parts[0];
	const second = parts[1];
	if (first && second) {
		return `${first[0] ?? ""}${second[0] ?? ""}`.toUpperCase();
	}
	return base.slice(0, 2).toUpperCase();
}

export function AppNavUser() {
	const { isMobile } = useSidebar();
	const { identity, signOut } = useSession();
	const { health } = useHealth();
	const name = identity.displayName;
	const email = identity.email ?? "";
	const role = roleLabel(identity.role);
	const initials = initialsFor(name, identity.email);

	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<SidebarMenuButton
								size="lg"
								tooltip={name}
								className={cn(
									"h-12 gap-2.5 rounded-lg px-2.5 data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground",
									"group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2!",
								)}
							/>
						}
					>
						<Avatar className="size-8 rounded-lg">
							<AvatarFallback className="rounded-lg bg-primary/15 text-sm text-primary">
								{initials}
							</AvatarFallback>
						</Avatar>
						<div className="grid flex-1 text-left text-sm leading-tight">
							<span className="truncate text-[0.9375rem] font-medium">
								{name}
							</span>
							<span className="truncate text-xs text-muted-foreground">
								{email}
							</span>
						</div>
						<ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
					</DropdownMenuTrigger>
					<DropdownMenuContent
						className="min-w-56 rounded-lg"
						side={isMobile ? "bottom" : "top"}
						align="start"
						sideOffset={4}
					>
						<DropdownMenuGroup>
							<DropdownMenuLabel className="p-0 font-normal">
								<div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
									<Avatar size="sm" className="rounded-lg">
										<AvatarFallback className="rounded-lg bg-primary/15 text-primary">
											{initials}
										</AvatarFallback>
									</Avatar>
									<div className="grid flex-1 text-left text-sm leading-tight">
										<span className="truncate font-medium">{name}</span>
										<span className="truncate text-xs text-muted-foreground">
											{email}
										</span>
										<span className="text-meta mt-0.5 truncate text-muted-foreground">
											{role}
										</span>
									</div>
								</div>
							</DropdownMenuLabel>
						</DropdownMenuGroup>
						<DropdownMenuSeparator />
						<DropdownMenuGroup>
							<DropdownMenuItem render={<Link href="/app/settings" />}>
								<Settings2 />
								工作区设置
							</DropdownMenuItem>
						</DropdownMenuGroup>
						<DropdownMenuSeparator />
						<DropdownMenuLabel className="flex items-center justify-between gap-3 px-2 py-1.5 font-normal text-muted-foreground">
							<span className="text-xs">UnoRAG</span>
							<span className="font-mono text-[11px] tabular-nums">
								{health ? formatReleaseVersion(health.release) : "version --"}
							</span>
						</DropdownMenuLabel>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onClick={() => {
								void signOut();
							}}
						>
							<LogOut />
							退出登录
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarMenuItem>
		</SidebarMenu>
	);
}
