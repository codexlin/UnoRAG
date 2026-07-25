"use client";

import { useCallback, useEffect, useState } from "react";

import { useSession } from "@/components/app/session-provider";
import { Button } from "@/components/ui/button";
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
};

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

	const load = useCallback(
		async (cursor: string | null, append: boolean) => {
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
		},
		[],
	);

	useEffect(() => {
		if (!canManage) return;
		void load(null, false);
	}, [canManage, load]);

	if (!canManage) {
		return (
			<div className="rounded-2xl border border-border/80 bg-card/80 px-4 py-4">
				<p className="text-meta font-mono tracking-[0.16em] text-muted-foreground uppercase">
					Audit
				</p>
				<p className="text-ui mt-2 text-muted-foreground">
					仅 owner / admin 可查看工作区审计日志与导出 CSV。
				</p>
			</div>
		);
	}

	return (
		<div className="space-y-4 rounded-2xl border border-border/80 bg-card/80 px-4 py-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<p className="text-meta font-mono tracking-[0.16em] text-muted-foreground uppercase">
						Audit
					</p>
					<p className="text-ui mt-1 text-muted-foreground">
						工作区操作记录。部分后台任务可能无操作者；仅展示已写入字段。
					</p>
				</div>
				<a
					href="/api/workspace/audit/export"
					className="inline-flex h-8 items-center rounded-md border border-border bg-background px-3 text-xs font-medium hover:bg-muted/60"
				>
					导出 CSV
				</a>
			</div>

			{loading ? (
				<p className="text-ui text-muted-foreground">加载中…</p>
			) : error ? (
				<p className="text-ui text-destructive" role="alert">
					{error}
				</p>
			) : items.length === 0 ? (
				<p className="text-ui text-muted-foreground">暂无审计记录</p>
			) : (
				<div className="overflow-x-auto">
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
							{items.map((item) => (
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
									<td className="py-2.5 pr-3 font-mono text-xs">
										{item.action}
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
						disabled={loadingMore}
						onClick={() => void load(nextCursor, true)}
					>
						{loadingMore ? "加载中…" : "加载更多"}
					</Button>
				</div>
			) : null}
		</div>
	);
}
