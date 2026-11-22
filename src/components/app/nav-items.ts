import {
	Activity,
	BookOpen,
	Clock3,
	History,
	type LucideIcon,
	MessagesSquare,
	Settings2,
} from "lucide-react";
import type { Cap } from "@/lib/client-permissions";

export type AppNavGroup = "nav" | "settings";

export type AppNavItem = {
	href:
		| "/app/ask"
		| "/app/libraries"
		| "/app/archive"
		| "/app/operations"
		| "/app/audit"
		| "/app/settings";
	code: string;
	label: readonly [zh: string, en: string];
	icon: LucideIcon;
	group: AppNavGroup;
	cap?: Cap;
};

const APP_NAV_ITEMS: AppNavItem[] = [
	{
		href: "/app/ask",
		code: "01",
		label: ["智能问答", "Ask"],
		icon: MessagesSquare,
		group: "nav",
	},
	{
		href: "/app/libraries",
		code: "02",
		label: ["知识库", "Knowledge libraries"],
		icon: BookOpen,
		group: "nav",
	},
	{
		href: "/app/archive",
		code: "03",
		label: ["会话历史", "Conversations"],
		icon: Clock3,
		group: "nav",
	},
	{
		href: "/app/operations",
		code: "04",
		label: ["运行中心", "Operations"],
		icon: Activity,
		group: "settings",
		cap: "manageMembers",
	},
	{
		href: "/app/audit",
		code: "05",
		label: ["操作记录", "Audit log"],
		icon: History,
		group: "settings",
		cap: "manageMembers",
	},
	{
		href: "/app/settings",
		code: "06",
		label: ["工作区", "Workspace"],
		icon: Settings2,
		group: "settings",
	},
];

export function getAppNavItemsByGroup(group: AppNavGroup) {
	return APP_NAV_ITEMS.filter((item) => item.group === group);
}

export function getAppNavItem(pathname: string) {
	return (
		APP_NAV_ITEMS.find(
			(item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
		) ?? APP_NAV_ITEMS[0]
	);
}
