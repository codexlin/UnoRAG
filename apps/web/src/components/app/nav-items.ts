import {
	Archive,
	BookMarked,
	type LucideIcon,
	MessageSquareText,
	Settings2,
} from "lucide-react";

export type AppNavItem = {
	href: "/app/ask" | "/app/libraries" | "/app/archive" | "/app/settings";
	code: string;
	label: string;
	hint: string;
	icon: LucideIcon;
};

export const APP_NAV_ITEMS: AppNavItem[] = [
	{
		href: "/app/ask",
		code: "01",
		label: "问答台",
		hint: "对着文库提问，核对引用",
		icon: MessageSquareText,
	},
	{
		href: "/app/libraries",
		code: "02",
		label: "文库",
		hint: "收录与整理资料",
		icon: BookMarked,
	},
	{
		href: "/app/archive",
		code: "03",
		label: "档案",
		hint: "回看过往问答",
		icon: Archive,
	},
	{
		href: "/app/settings",
		code: "04",
		label: "设置",
		hint: "工作区与服务状态",
		icon: Settings2,
	},
];

export function getAppNavItem(pathname: string) {
	return (
		APP_NAV_ITEMS.find(
			(item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
		) ?? APP_NAV_ITEMS[0]
	);
}
