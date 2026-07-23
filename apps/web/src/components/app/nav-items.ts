import {
	BookOpen,
	Clock3,
	type LucideIcon,
	MessagesSquare,
	Settings2,
} from "lucide-react";

export type AppNavGroup = "nav" | "settings";

export type AppNavItem = {
	href: "/app/ask" | "/app/libraries" | "/app/archive" | "/app/settings";
	code: string;
	label: string;
	hint: string;
	icon: LucideIcon;
	group: AppNavGroup;
};

export const APP_NAV_ITEMS: AppNavItem[] = [
	{
		href: "/app/ask",
		code: "01",
		label: "智能问答",
		hint: "基于知识库检索回答并核对来源",
		icon: MessagesSquare,
		group: "nav",
	},
	{
		href: "/app/libraries",
		code: "02",
		label: "知识库",
		hint: "管理文档、索引与解析状态",
		icon: BookOpen,
		group: "nav",
	},
	{
		href: "/app/archive",
		code: "03",
		label: "会话历史",
		hint: "回看问答记录与引用来源",
		icon: Clock3,
		group: "nav",
	},
	{
		href: "/app/settings",
		code: "04",
		label: "工作区",
		hint: "服务健康与运行配置",
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
