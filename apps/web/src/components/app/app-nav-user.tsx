"use client";

import { BadgeCheck, ChevronsUpDown, LogOut, Settings2 } from "lucide-react";
import Link from "next/link";

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
import { cn } from "@/lib/utils";

/** Placeholder until auth is wired. Swap with session user. */
const PLACEHOLDER_USER = {
	name: "演示用户",
	email: "you@company.com",
	role: "工作区管理员",
	initials: "演",
};

export function AppNavUser() {
	const { isMobile } = useSidebar();
	const user = PLACEHOLDER_USER;

	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<SidebarMenuButton
								size="lg"
								tooltip={user.name}
								className={cn(
									"h-12 gap-2.5 rounded-lg px-2.5 data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground",
									"group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2!",
								)}
							/>
						}
					>
						<Avatar className="size-8 rounded-lg">
							<AvatarFallback className="rounded-lg bg-primary/15 text-sm text-primary">
								{user.initials}
							</AvatarFallback>
						</Avatar>
						<div className="grid flex-1 text-left text-sm leading-tight">
							<span className="truncate text-[0.9375rem] font-medium">
								{user.name}
							</span>
							<span className="truncate text-xs text-muted-foreground">
								{user.email}
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
											{user.initials}
										</AvatarFallback>
									</Avatar>
									<div className="grid flex-1 text-left text-sm leading-tight">
										<span className="truncate font-medium">{user.name}</span>
										<span className="truncate text-xs text-muted-foreground">
											{user.email}
										</span>
										<span className="text-meta mt-0.5 truncate text-muted-foreground">
											{user.role}
										</span>
									</div>
								</div>
							</DropdownMenuLabel>
						</DropdownMenuGroup>
						<DropdownMenuSeparator />
						<DropdownMenuGroup>
							<DropdownMenuItem disabled>
								<BadgeCheck />
								账户（即将接入）
							</DropdownMenuItem>
							<DropdownMenuItem render={<Link href="/app/settings" />}>
								<Settings2 />
								工作区设置
							</DropdownMenuItem>
						</DropdownMenuGroup>
						<DropdownMenuSeparator />
						<DropdownMenuItem disabled>
							<LogOut />
							退出登录
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarMenuItem>
		</SidebarMenu>
	);
}
