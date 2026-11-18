"use client";

import type { LucideIcon } from "lucide-react";
import {
	CircleStop,
	Download,
	Eye,
	Replace,
	RotateCcw,
	Shield,
	Trash2,
} from "lucide-react";

import type { ApiDocument } from "@/lib/api";
import type { CapExpr, PermissionCaps } from "@/lib/client-permissions";
import { filterByCap } from "@/lib/client-permissions";

export type DocActionContext = {
	busy: boolean;
	processing: boolean;
	onView: (doc: ApiDocument) => void;
	onAcl: (doc: ApiDocument) => void;
	onReplace: (doc: ApiDocument) => void;
	onReindex: (doc: ApiDocument) => void;
	onCancelJob: (doc: ApiDocument) => void;
	onRetryJob: (doc: ApiDocument) => void;
	onDownload: (doc: ApiDocument) => void;
	onDelete: (doc: ApiDocument) => void;
};

export type DocAction = {
	id: string;
	cap: CapExpr;
	label: string;
	icon: LucideIcon;
	destructive?: boolean;
	separatorBefore?: boolean;
	visible?: (doc: ApiDocument) => boolean;
	disabled?: (doc: ApiDocument, ctx: DocActionContext) => boolean;
	run: (doc: ApiDocument, ctx: DocActionContext) => void;
};

const DOC_ACTIONS: DocAction[] = [
	{
		id: "view",
		cap: "read",
		label: "查看",
		icon: Eye,
		run: (doc, ctx) => ctx.onView(doc),
	},
	{
		id: "acl",
		cap: "writeLibraries",
		label: "谁可见",
		icon: Shield,
		disabled: (doc, ctx) => doc.status === "deleting" || ctx.busy,
		run: (doc, ctx) => ctx.onAcl(doc),
	},
	{
		id: "replace",
		cap: "writeLibraries",
		label: "替换文件",
		icon: Replace,
		disabled: (doc, ctx) =>
			doc.status === "deleting" || ctx.processing || ctx.busy,
		run: (doc, ctx) => ctx.onReplace(doc),
	},
	{
		id: "reindex",
		cap: "writeLibraries",
		label: "重索引",
		icon: RotateCcw,
		disabled: (doc, ctx) =>
			doc.status === "deleting" || !doc.has_file || ctx.processing || ctx.busy,
		run: (doc, ctx) => ctx.onReindex(doc),
	},
	{
		id: "cancel",
		cap: "writeLibraries",
		label: "取消任务",
		icon: CircleStop,
		visible: (doc) =>
			Boolean(
				doc.status !== "deleting" &&
					doc.job_id &&
					["queued", "running", "retry", "cancelling"].includes(
						doc.job_status ?? "",
					),
			),
		disabled: (doc, ctx) => doc.job_status === "cancelling" || ctx.busy,
		run: (doc, ctx) => ctx.onCancelJob(doc),
	},
	{
		id: "retry",
		cap: "writeLibraries",
		label: "重试任务",
		icon: RotateCcw,
		visible: (doc) =>
			Boolean(
				doc.job_id &&
					["cancelled", "failed", "dead"].includes(doc.job_status ?? ""),
			),
		disabled: (doc, ctx) =>
			(doc.status !== "deleting" && !doc.has_file) || ctx.busy,
		run: (doc, ctx) => ctx.onRetryJob(doc),
	},
	{
		id: "download",
		cap: "read",
		label: "下载",
		icon: Download,
		disabled: (doc, ctx) => !doc.has_file || ctx.busy,
		run: (doc, ctx) => ctx.onDownload(doc),
	},
	{
		id: "delete",
		cap: "manageLibraries",
		label: "删除",
		icon: Trash2,
		destructive: true,
		separatorBefore: true,
		disabled: (doc, ctx) => doc.status === "deleting" || ctx.busy,
		run: (doc, ctx) => ctx.onDelete(doc),
	},
];

export function resolveDocActions(
	caps: PermissionCaps,
	doc: ApiDocument,
): DocAction[] {
	return filterByCap(caps, DOC_ACTIONS).filter(
		(action) =>
			(action.id !== "retry" ||
				doc.status !== "deleting" ||
				caps.canManageLibraries) &&
			(action.visible?.(doc) ?? true),
	);
}

export type DetailAction = {
	id: string;
	cap: CapExpr;
	label: string;
	icon: LucideIcon;
	variant?: "outline" | "destructive";
	disabled?: (doc: ApiDocument, busy: boolean) => boolean;
	run: (doc: ApiDocument) => void;
};

export function buildDetailActions(
	caps: PermissionCaps,
	document: ApiDocument | null,
	handlers: Omit<DocActionContext, "busy" | "processing">,
): DetailAction[] {
	if (!document) return [];
	const context: DocActionContext = {
		...handlers,
		busy: false,
		processing: document.status === "processing",
	};
	return resolveDocActions(caps, document)
		.filter((action) => action.id !== "view")
		.map((action) => ({
			id: action.id,
			cap: action.cap,
			label: action.label,
			icon: action.icon,
			variant: action.destructive ? "destructive" : "outline",
			disabled: (doc, busy) =>
				action.disabled?.(doc, { ...context, busy }) ?? false,
			run: (doc) => action.run(doc, context),
		}));
}
