"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { AppNavUser } from "@/components/app/app-nav-user";
import { MeriKnowMark } from "@/components/app/meriknow-logo";
import {
	type AppNavItem,
	getAppNavItemsByGroup,
} from "@/components/app/nav-items";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

const PRIMARY_NAV = getAppNavItemsByGroup("nav");
const SETTINGS_NAV = getAppNavItemsByGroup("settings");

function NavLink({ item }: { item: AppNavItem }) {
	const pathname = usePathname();
	const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
	const Icon = item.icon;

	return (
		<SidebarMenuItem>
			<SidebarMenuButton
				render={<Link href={item.href} />}
				isActive={active}
				tooltip={item.label}
				className={cn(
					"relative h-11 gap-3 overflow-visible rounded-lg px-2.5 text-[0.9375rem] font-medium",
					/* 覆盖 SidebarMenuButton 默认的 width/height 过渡，只做轻量变色 */
					"transition-[background-color,color]! duration-150! ease-out!",
					"hover:bg-primary/12 hover:text-foreground",
					"group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:overflow-hidden group-data-[collapsible=icon]:p-1.5!",
					"data-active:bg-card data-active:font-medium data-active:text-foreground",
					"data-active:hover:bg-card",
					active && "bg-card text-foreground ring-1 ring-border/70",
				)}
			>
				<span
					className={cn(
						"flex size-8 shrink-0 items-center justify-center rounded-md border [&_svg]:size-4",
						"transition-[background-color,border-color,color] duration-150 ease-out",
						"group-data-[collapsible=icon]:size-5 group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:[&_svg]:size-4",
						active
							? "border-primary/30 bg-primary/15 text-primary"
							: "border-border/70 bg-background/70 text-muted-foreground group-hover/menu-button:border-primary/40 group-hover/menu-button:bg-primary/15 group-hover/menu-button:text-primary",
					)}
				>
					<Icon aria-hidden />
				</span>
				<span className="truncate">{item.label}</span>
				{active ? (
					<span
						className="absolute top-1/2 right-0 h-6 w-0.5 -translate-y-1/2 rounded-full bg-cite group-data-[collapsible=icon]:hidden"
						aria-hidden
					/>
				) : null}
			</SidebarMenuButton>
		</SidebarMenuItem>
	);
}

export function AppSidebar() {
	return (
		<Sidebar
			collapsible="icon"
			variant="sidebar"
			className="border-sidebar-border bg-sidebar/90 backdrop-blur-sm"
		>
			<SidebarHeader className="h-14 justify-center border-b border-sidebar-border px-2">
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton
							size="lg"
							render={<Link href="/" />}
							tooltip="MeriKnow"
							className={cn(
								"h-10 gap-2.5 rounded-lg px-2 hover:bg-primary/10",
								"[&_img]:size-7!",
								"group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-1.5! group-data-[collapsible=icon]:[&_img]:size-6!",
							)}
						>
							<MeriKnowMark decorative />
							<span className="font-heading text-lg font-semibold tracking-tight text-primary">
								MeriKnow
							</span>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarHeader>

			<SidebarContent className="pt-1">
				<SidebarGroup>
					<SidebarGroupLabel className="text-meta font-mono tracking-[0.14em] text-muted-foreground uppercase">
						导航
					</SidebarGroupLabel>
					<SidebarGroupContent>
						<SidebarMenu className="gap-1.5">
							{PRIMARY_NAV.map((item) => (
								<NavLink key={item.href} item={item} />
							))}
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>

				{/* 紧挨主导航，不沉底 */}
				<SidebarGroup>
					<SidebarGroupLabel className="text-meta font-mono tracking-[0.14em] text-muted-foreground uppercase">
						系统设置
					</SidebarGroupLabel>
					<SidebarGroupContent>
						<SidebarMenu className="gap-1.5">
							{SETTINGS_NAV.map((item) => (
								<NavLink key={item.href} item={item} />
							))}
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>
			</SidebarContent>

			<SidebarFooter className="border-t border-sidebar-border p-2">
				<AppNavUser />
			</SidebarFooter>
			<SidebarRail />
		</Sidebar>
	);
}
