"use client";

import { Download, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { HelpTip } from "@/components/app/help-tip";
import { useSession } from "@/components/app/session-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { formatDateTime } from "@/lib/format";

type AuditItem = {
	id: string;
	created_at: string;
	actor: {
		id: string | null;
		display_name: string | null;
		email: string | null;
		label: string | null;
	};
	action: string;
	resource: {
		type: string;
		id: string | null;
	};
	metadata_summary: string;
	request_id: string | null;
	details: Record<string, unknown>;
	ip_address: string | null;
	user_agent: string | null;
};

const ACTION_LABELS: Record<string, string> = {
	"document.uploaded": "上传文档",
	"document.version_created": "创建文档版本",
	"document.reindex_requested": "请求重新索引",
	"document.generation_activated": "激活索引版本",
	"document.delete_requested": "请求删除文档",
	"document.deleted": "删除文档",
	"document.acl_updated": "更新文档权限",
	"library.created": "创建知识库",
	"library.updated": "更新知识库",
	"library.delete_requested": "请求删除知识库",
	"library.deleted": "删除知识库",
	"library.delete_failed": "知识库删除失败",
	"job.cancel_requested": "取消任务",
	"job.retried": "重试任务",
	"workspace.created": "创建工作区",
	"workspace.service_key_created": "创建服务密钥",
	"workspace.service_key_revoked": "撤销服务密钥",
	"auth.password_changed": "修改密码",
	"knowledge.ask": "公共 API 问答",
	"knowledge.retrieve": "公共 API 检索",
};

function actionLabel(action: string) {
	return ACTION_LABELS[action] ?? action;
}

function actorLabel(item: AuditItem): string {
	if (item.actor.label) return item.actor.label;
	return "（无操作者）";
}

function resourceLabel(item: AuditItem): string {
	if (item.resource.id) {
		return `${item.resource.type}:${item.resource.id}`;
	}
	return item.resource.type;
}

export function WorkspaceAuditPanel() {
	const { can } = useSession();
	const canManage = can("manageMembers");
	const [items, setItems] = useState<AuditItem[]>([]);
	const [nextCursor, setNextCursor] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<AuditItem | null>(null);
	const titleRef = useRef<HTMLHeadingElement | null>(null);

	const load = useCallback(async (cursor: string | null, append: boolean) => {
		if (append) setLoadingMore(true);
		else setLoading(true);
		setError(null);
		const params = new URLSearchParams({ limit: "30" });
		if (cursor) params.set("cursor", cursor);
		const response = await fetch(`/api/workspace/audit?${params}`);
		if (!response.ok) {
			if (response.status === 403) {
				setError("无权限查看审计日志（需要 owner 或 admin）");
			} else if (response.status === 401) {
				setError("请先登录");
			} else {
				const detail = await response.json().catch(() => null);
				setError(
					typeof detail?.detail === "string"
						? detail.detail
						: "加载审计日志失败",
				);
			}
			if (!append) setItems([]);
			setNextCursor(null);
			setLoading(false);
			setLoadingMore(false);
			return;
		}
		const data = (await response.json()) as {
			items: AuditItem[];
			next_cursor: string | null;
		};
		setItems((prev) => (append ? [...prev, ...data.items] : data.items));
		setNextCursor(data.next_cursor);
		setLoading(false);
		setLoadingMore(false);
	}, []);

	useEffect(() => {
		if (!canManage) return;
		void load(null, false);
	}, [canManage, load]);
	const visibleItems = useMemo(() => {
		const normalized = query.trim().toLocaleLowerCase();
		if (!normalized) return items;
		return items.filter((item) =>
			`${item.action} ${actionLabel(item.action)} ${actorLabel(item)} ${resourceLabel(item)} ${item.metadata_summary} ${item.request_id ?? ""} ${JSON.stringify(item.details)}`
				.toLocaleLowerCase()
				.includes(normalized),
		);
	}, [items, query]);

	if (!canManage) {
		return (
			<section className="border-t border-border py-6">
				<h3 className="text-base font-medium">操作记录</h3>
				<p className="text-ui mt-2 text-muted-foreground">
					仅 owner / admin 可查看工作区审计日志与导出 CSV。
				</p>
			</section>
		);
	}

	return (
		<div className="min-w-0 space-y-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="flex items-center gap-2">
					<a
						href="/api/workspace/audit/export"
						className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-muted/60"
					>
						<Download className="size-4" aria-hidden />
						导出 CSV
					</a>
					<HelpTip label="操作记录权限说明">
						仅 owner / admin 可查看操作记录和导出 CSV。
					</HelpTip>
				</div>
			</div>
			<div className="relative max-w-sm">
				<Search className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
				<Input
					aria-label="筛选已加载的操作记录"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="筛选已加载记录"
					className="h-11 pl-9"
				/>
			</div>

			{loading ? (
				<p className="text-ui text-muted-foreground">加载中…</p>
			) : error ? (
				<p className="text-ui text-destructive" role="alert">
					{error}
				</p>
			) : visibleItems.length === 0 ? (
				<p className="text-ui text-muted-foreground">暂无审计记录</p>
			) : (
				<div className="max-w-full overflow-x-auto">
					<table className="w-full min-w-xl border-collapse text-left text-sm">
						<thead>
							<tr className="border-b border-border/60 text-xs text-muted-foreground">
								<th className="py-2 pr-3 font-medium">时间</th>
								<th className="py-2 pr-3 font-medium">操作者</th>
								<th className="py-2 pr-3 font-medium">动作</th>
								<th className="py-2 pr-3 font-medium">资源</th>
								<th className="py-2 font-medium">摘要</th>
							</tr>
						</thead>
						<tbody>
							{visibleItems.map((item) => (
								<tr
									key={item.id}
									className="border-b border-border/40 align-top last:border-0"
								>
									<td className="py-2.5 pr-3 font-mono text-xs whitespace-nowrap text-muted-foreground">
										{formatDateTime(item.created_at)}
									</td>
									<td className="py-2.5 pr-3 text-xs">
										<span className="block max-w-40 truncate">
											{actorLabel(item)}
										</span>
									</td>
									<td className="py-2.5 pr-3 text-xs">
										<button
											type="button"
											onClick={() => setSelected(item)}
											className="min-h-11 text-left font-medium text-evidence underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
											title={item.action}
										>
											{actionLabel(item.action)}
										</button>
									</td>
									<td className="py-2.5 pr-3 font-mono text-xs text-muted-foreground">
										<span className="block max-w-48 truncate">
											{resourceLabel(item)}
										</span>
									</td>
									<td className="py-2.5 text-xs text-muted-foreground">
										<span className="line-clamp-2 max-w-64">
											{item.metadata_summary || "—"}
										</span>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			{nextCursor ? (
				<div className="flex justify-center pt-1">
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="h-11"
						disabled={loadingMore}
						onClick={() => void load(nextCursor, true)}
					>
						{loadingMore ? "加载中…" : "加载更多"}
					</Button>
				</div>
			) : null}
			<Sheet
				open={selected != null}
				onOpenChange={(open) => !open && setSelected(null)}
			>
				<SheetContent
					side="right"
					initialFocus={titleRef}
					className="w-full gap-0 sm:max-w-lg [&>[data-slot=sheet-close]]:size-11"
					showCloseButton
				>
					{selected ? (
						<>
							<SheetHeader className="border-b border-border/70">
								<SheetTitle ref={titleRef} tabIndex={-1} className="pr-8">
									{actionLabel(selected.action)}
								</SheetTitle>
								<SheetDescription>
									{formatDateTime(selected.created_at)}
								</SheetDescription>
							</SheetHeader>
							<div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
								<dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
									{[
										["操作者", actorLabel(selected)],
										["动作代码", selected.action],
										["资源", resourceLabel(selected)],
										["Request ID", selected.request_id ?? "—"],
										["来源 IP", selected.ip_address ?? "—"],
									].map(([label, value]) => (
										<div key={label} className="contents">
											<dt className="text-muted-foreground">{label}</dt>
											<dd className="break-all font-mono">{value}</dd>
										</div>
									))}
								</dl>
								<section>
									<p className="text-sm font-medium">元数据</p>
									<pre className="mt-2 max-h-80 overflow-auto border border-border/70 bg-muted/25 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
										{JSON.stringify(selected.details, null, 2)}
									</pre>
								</section>
							</div>
						</>
					) : null}
				</SheetContent>
			</Sheet>
		</div>
	);
}
