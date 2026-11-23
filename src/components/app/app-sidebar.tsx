"use client";

import { usePathname } from "next/navigation";
import { AppNavUser } from "@/components/app/app-nav-user";
import {
	type AppNavItem,
	getAppNavItemsByGroup,
} from "@/components/app/nav-items";
import { GuardedLink } from "@/components/app/navigation-guard";
import { useSession } from "@/components/app/session-provider";
import { UnoMark } from "@/components/app/unorag-logo";
import { WorkspaceSwitcher } from "@/components/app/workspace-switcher";
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
import { allowsCap } from "@/lib/client-permissions";
import { useInterfaceText } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

const PRIMARY_NAV = getAppNavItemsByGroup("nav");
const SETTINGS_NAV = getAppNavItemsByGroup("settings");

function NavLink({ item }: { item: AppNavItem }) {
	const t = useInterfaceText();
	const label = t(...item.label);
	const pathname = usePathname();
	const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
	const Icon = item.icon;

	return (
		<SidebarMenuItem>
			<SidebarMenuButton
				render={<GuardedLink href={item.href} />}
				aria-label={label}
				aria-current={active ? "page" : undefined}
				isActive={active}
				tooltip={label}
				className={cn(
					"relative h-11 gap-3 rounded-lg px-3 text-sm font-medium",
					/* 覆盖 SidebarMenuButton 默认的 width/height 过渡，只做轻量变色 */
					"transition-[background-color,color]! duration-150! ease-out!",
					"hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground",
					"group-data-[collapsible=icon]:size-11! group-data-[collapsible=icon]:-mx-0.5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:p-0!",
					"data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground data-active:[&_svg]:text-sidebar-primary",
				)}
			>
				<span className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-4">
					<Icon aria-hidden />
				</span>
				<span className="truncate group-data-[collapsible=icon]:sr-only">
					{label}
				</span>
			</SidebarMenuButton>
		</SidebarMenuItem>
	);
}

export function AppSidebar() {
	const t = useInterfaceText();
	const { caps } = useSession();
	const primaryNav = PRIMARY_NAV.filter(
		(item) => !item.cap || allowsCap(caps, item.cap),
	);
	const settingsNav = SETTINGS_NAV.filter(
		(item) => !item.cap || allowsCap(caps, item.cap),
	);
	return (
		<Sidebar
			collapsible="icon"
			variant="sidebar"
			className="border-border bg-sidebar"
		>
			<SidebarHeader className="h-14 justify-center border-b border-border px-2">
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton
							size="lg"
							render={<GuardedLink href="/" />}
							aria-label={t("UnoRAG 首页", "UnoRAG home")}
							tooltip="UnoRAG"
							className={cn(
								"h-10 gap-2.5 rounded-lg px-2 hover:bg-primary/10",
								"[&_img]:size-7!",
								"group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-1.5! group-data-[collapsible=icon]:[&_img]:size-6!",
							)}
						>
							<UnoMark decorative />
							<span className="font-heading text-lg font-semibold tracking-normal text-foreground">
								Uno<span className="text-primary">RAG</span>
							</span>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarHeader>

			<SidebarContent className="pt-1">
				<SidebarGroup className="pb-0">
					<WorkspaceSwitcher />
				</SidebarGroup>
				<SidebarGroup>
					<SidebarGroupLabel className="text-xs text-muted-foreground">
						{t("导航", "Navigation")}
					</SidebarGroupLabel>
					<SidebarGroupContent>
						<SidebarMenu className="gap-1">
							{primaryNav.map((item) => (
								<NavLink key={item.href} item={item} />
							))}
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>

				{/* 紧挨主导航，不沉底 */}
				<SidebarGroup>
					<SidebarGroupLabel className="text-xs text-muted-foreground">
						{t("系统设置", "System")}
					</SidebarGroupLabel>
					<SidebarGroupContent>
						<SidebarMenu className="gap-1">
							{settingsNav.map((item) => (
								<NavLink key={item.href} item={item} />
							))}
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>
			</SidebarContent>

			<SidebarFooter className="border-t border-border p-2">
				<AppNavUser />
			</SidebarFooter>
			<SidebarRail />
		</Sidebar>
	);
}
