"use client";

import { CheckCircle2, Download, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	fetchOperationsFeedback,
	updateOperationsFeedbackTriage,
} from "@/lib/api";
import {
	ASK_FEEDBACK_REASON_CODES,
	ASK_FEEDBACK_REASON_LABELS,
	ASK_FEEDBACK_TRIAGE_LABELS,
	ASK_FEEDBACK_TRIAGE_STATUSES,
	type AskFeedbackReasonCode,
	type AskFeedbackRecord,
	type AskFeedbackTriageStatus,
	buildGoldenCaseSkeleton,
} from "@/lib/ask-feedback";
import { formatDateTime, formatDurationMs } from "@/lib/format";
import { cn } from "@/lib/utils";

const TRIAGE_BADGE_CLASSES: Record<AskFeedbackTriageStatus, string> = {
	open: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
	resolved:
		"border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
	exported: "border-border bg-muted text-muted-foreground",
};

export function OperationsFeedbackPanel({
	workspaceId,
}: {
	workspaceId: string;
}) {
	const [items, setItems] = useState<AskFeedbackRecord[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [triageFilter, setTriageFilter] = useState<string>("all");
	const [reasonFilter, setReasonFilter] = useState<string>("all");
	const [updatingId, setUpdatingId] = useState<string | null>(null);

	const load = useCallback(
		async (signal?: AbortSignal) => {
			setLoading(true);
			setError(null);
			try {
				const rows = await fetchOperationsFeedback({
					rating: "down",
					triage_status:
						triageFilter === "all"
							? undefined
							: (triageFilter as AskFeedbackTriageStatus),
					reason_code:
						reasonFilter === "all"
							? undefined
							: (reasonFilter as AskFeedbackReasonCode),
					limit: 100,
					signal,
				});
				setItems(rows);
			} catch (err) {
				if (err instanceof Error && err.name === "AbortError") return;
				setError(err instanceof Error ? err.message : "加载 Bad Case 列表失败");
			} finally {
				setLoading(false);
			}
		},
		[triageFilter, reasonFilter],
	);

	useEffect(() => {
		const controller = new AbortController();
		void workspaceId;
		void load(controller.signal);
		return () => controller.abort();
	}, [workspaceId, load]);

	async function handleTriageChange(
		feedbackId: string,
		nextStatus: AskFeedbackTriageStatus,
	) {
		setUpdatingId(feedbackId);
		try {
			const updated = await updateOperationsFeedbackTriage({
				feedback_id: feedbackId,
				triage_status: nextStatus,
			});
			setItems((prev) =>
				prev.map((item) =>
					item.id === feedbackId
						? {
								...item,
								triage_status: updated.triage_status,
								updated_at: updated.updated_at,
							}
						: item,
				),
			);
			toast.success("已更新处理状态");
		} catch (err) {
			toast.error("状态更新失败", {
				description: err instanceof Error ? err.message : "请稍后重试",
			});
		} finally {
			setUpdatingId(null);
		}
	}

	async function exportJsonl() {
		if (items.length === 0) return;
		const lines = items
			.map((item) => JSON.stringify(buildGoldenCaseSkeleton(item)))
			.join("\n");
		const blob = new Blob([`${lines}\n`], {
			type: "application/x-ndjson;charset=utf-8",
		});
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `bad-cases-${new Date().toISOString().slice(0, 10)}.jsonl`;
		anchor.click();
		URL.revokeObjectURL(url);
		toast.success(`已导出 ${items.length} 条脱敏黄金集骨架`);
	}

	return (
		<section className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h2 className="text-base font-medium">Bad Case 反馈队列</h2>
					<p className="text-xs text-muted-foreground">
						仅展示脱敏运行元数据，不包含提问正文、回答与引用原文；可导出为黄金集回归骨架。
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Select
						value={triageFilter}
						onValueChange={(value) => setTriageFilter(value ?? "all")}
					>
						<SelectTrigger className="w-36" aria-label="按处理状态筛选">
							<SelectValue>
								{triageFilter === "all"
									? "全部状态"
									: ((ASK_FEEDBACK_TRIAGE_LABELS as Record<string, string>)[
											triageFilter
										] ?? triageFilter)}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">全部状态</SelectItem>
							{ASK_FEEDBACK_TRIAGE_STATUSES.map((status) => (
								<SelectItem key={status} value={status}>
									{ASK_FEEDBACK_TRIAGE_LABELS[status]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Select
						value={reasonFilter}
						onValueChange={(value) => setReasonFilter(value ?? "all")}
					>
						<SelectTrigger className="w-44" aria-label="按反馈原因筛选">
							<SelectValue>
								{reasonFilter === "all"
									? "全部原因"
									: ((ASK_FEEDBACK_REASON_LABELS as Record<string, string>)[
											reasonFilter
										] ?? reasonFilter)}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">全部原因</SelectItem>
							{ASK_FEEDBACK_REASON_CODES.map((code) => (
								<SelectItem key={code} value={code}>
									{ASK_FEEDBACK_REASON_LABELS[code]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={loading}
						onClick={() => void load()}
					>
						<RefreshCw
							className={cn(
								"mr-1.5 size-3.5",
								loading && "motion-safe:animate-spin",
							)}
							aria-hidden
						/>
						刷新
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={items.length === 0}
						onClick={() => void exportJsonl()}
					>
						<Download className="mr-1.5 size-3.5" aria-hidden />
						导出黄金集骨架
					</Button>
				</div>
			</div>

			{error ? (
				<div
					role="alert"
					className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
				>
					{error}
				</div>
			) : loading ? (
				<div className="rounded-lg border border-border px-4 py-8 text-center text-sm text-muted-foreground">
					正在加载 Bad Case 队列…
				</div>
			) : items.length === 0 ? (
				<div className="rounded-lg border border-border px-4 py-8 text-center text-sm text-muted-foreground">
					当前筛选条件下暂无 Bad Case 反馈。
				</div>
			) : (
				<div className="overflow-x-auto rounded-lg border border-border">
					<table className="w-full border-collapse text-left text-sm">
						<thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
							<tr>
								<th className="px-3 py-2 font-medium">request_id</th>
								<th className="px-3 py-2 font-medium">原因</th>
								<th className="px-3 py-2 font-medium">类型 / 状态</th>
								<th className="px-3 py-2 font-medium">引用 / 耗时</th>
								<th className="px-3 py-2 font-medium">反馈时间</th>
								<th className="px-3 py-2 font-medium">治理状态</th>
								<th className="px-3 py-2 text-right font-medium">操作</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-border">
							{items.map((item) => (
								<tr key={item.id} className="hover:bg-muted/20">
									<td className="px-3 py-2.5 font-mono text-xs">
										{item.request_id.slice(0, 8)}…
									</td>
									<td className="px-3 py-2.5">
										{item.reason_code
											? ASK_FEEDBACK_REASON_LABELS[item.reason_code]
											: "未选择原因"}
									</td>
									<td className="px-3 py-2.5 text-xs text-muted-foreground">
										{item.query_type ?? "-"} · {item.run_status}
									</td>
									<td className="px-3 py-2.5 font-mono text-xs tabular-nums text-muted-foreground">
										{item.citation_count} 条 ·{" "}
										{item.latency_ms != null
											? formatDurationMs(item.latency_ms)
											: "-"}
									</td>
									<td className="px-3 py-2.5 text-xs text-muted-foreground">
										{formatDateTime(item.updated_at)}
									</td>
									<td className="px-3 py-2.5">
										<span
											className={cn(
												"inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium",
												TRIAGE_BADGE_CLASSES[item.triage_status],
											)}
										>
											{ASK_FEEDBACK_TRIAGE_LABELS[item.triage_status]}
										</span>
									</td>
									<td className="px-3 py-2.5 text-right">
										<div className="inline-flex items-center gap-1">
											{item.triage_status !== "resolved" ? (
												<Button
													type="button"
													variant="ghost"
													size="sm"
													disabled={updatingId === item.id}
													onClick={() =>
														void handleTriageChange(item.id, "resolved")
													}
												>
													<CheckCircle2 className="mr-1 size-3.5" aria-hidden />
													标记已确认
												</Button>
											) : (
												<Button
													type="button"
													variant="ghost"
													size="sm"
													disabled={updatingId === item.id}
													onClick={() =>
														void handleTriageChange(item.id, "open")
													}
												>
													重新打开
												</Button>
											)}
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}
