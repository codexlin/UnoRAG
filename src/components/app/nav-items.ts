import {
	Activity,
	BookOpen,
	Clock3,
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
		| "/app/settings";
	code: string;
	label: string;
	hint: string;
	icon: LucideIcon;
	group: AppNavGroup;
	cap?: Cap;
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
		hint: "归档会话回放与继续对话",
		icon: Clock3,
		group: "nav",
	},
	{
		href: "/app/operations",
		code: "04",
		label: "运行中心",
		hint: "请求质量、任务队列与发布熔断信号",
		icon: Activity,
		group: "settings",
		cap: "manageMembers",
	},
	{
		href: "/app/settings",
		code: "05",
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
