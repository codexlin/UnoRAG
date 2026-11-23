"use client";

import { CheckCircle2, Download, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { feedbackReasonLabel } from "@/components/app/ask/feedback-reason-label";
import {
	LedgerTable,
	LedgerTableSkeleton,
} from "@/components/app/ledger-table";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	TableBody,
	TableCell,
	TableHead,
	TableRow,
} from "@/components/ui/table";
import {
	fetchOperationsFeedback,
	updateOperationsFeedbackTriage,
} from "@/lib/api";
import {
	ASK_FEEDBACK_REASON_CODES,
	ASK_FEEDBACK_TRIAGE_LABELS,
	ASK_FEEDBACK_TRIAGE_STATUSES,
	type AskFeedbackReasonCode,
	type AskFeedbackRecord,
	type AskFeedbackTriageStatus,
	buildGoldenCaseSkeleton,
} from "@/lib/ask-feedback";
import { formatDateTime, formatDurationMs } from "@/lib/format";
import { useInterfaceText } from "@/lib/i18n/provider";
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
	const t = useInterfaceText();
	const [items, setItems] = useState<AskFeedbackRecord[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [triageFilter, setTriageFilter] = useState<string>("all");
	const [reasonFilter, setReasonFilter] = useState<string>("all");
	const [updatingId, setUpdatingId] = useState<string | null>(null);
	const reasonLabels = Object.fromEntries(
		ASK_FEEDBACK_REASON_CODES.map((code) => [
			code,
			feedbackReasonLabel(code, t),
		]),
	);
	const triageLabels: Record<AskFeedbackTriageStatus, string> = {
		open: t(ASK_FEEDBACK_TRIAGE_LABELS.open, "Open"),
		resolved: t(ASK_FEEDBACK_TRIAGE_LABELS.resolved, "Resolved"),
		exported: t(ASK_FEEDBACK_TRIAGE_LABELS.exported, "Exported"),
	};

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
				setError(
					err instanceof Error
						? err.message
						: t("加载 Bad Case 列表失败", "Failed to load bad-case queue"),
				);
			} finally {
				setLoading(false);
			}
		},
		[triageFilter, reasonFilter, t],
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
			toast.success(t("已更新处理状态", "Triage status updated"));
		} catch (err) {
			toast.error(t("状态更新失败", "Failed to update status"), {
				description:
					err instanceof Error
						? err.message
						: t("请稍后重试", "Try again later"),
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
		toast.success(
			t(
				`已导出 ${items.length} 条脱敏黄金集骨架`,
				items.length === 1
					? "Exported 1 sanitized golden-case skeleton"
					: `Exported ${items.length} sanitized golden-case skeletons`,
			),
		);
	}

	return (
		<section className="flex min-h-0 flex-1 flex-col gap-4 md:overflow-hidden md:pb-4">
			<div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
				<div>
					<h2 className="text-base font-medium">
						{t("Bad Case 反馈队列", "Bad-case feedback queue")}
					</h2>
					<p className="text-xs text-muted-foreground">
						{t(
							"仅展示脱敏运行元数据，不包含提问正文、回答与引用原文；可导出为黄金集回归骨架。",
							"Shows sanitized run metadata only — no prompts, answers, or cited text. Exportable as golden-case regression skeletons.",
						)}
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Select
						value={triageFilter}
						onValueChange={(value) => setTriageFilter(value ?? "all")}
					>
						<SelectTrigger
							className="h-11 w-36 bg-background md:h-9"
							aria-label={t("按处理状态筛选", "Filter by triage status")}
						>
							<SelectValue>
								{triageFilter === "all"
									? t("全部状态", "All statuses")
									: ((triageLabels as Record<string, string>)[triageFilter] ??
										triageFilter)}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">
								{t("全部状态", "All statuses")}
							</SelectItem>
							{ASK_FEEDBACK_TRIAGE_STATUSES.map((status) => (
								<SelectItem key={status} value={status}>
									{triageLabels[status]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Select
						value={reasonFilter}
						onValueChange={(value) => setReasonFilter(value ?? "all")}
					>
						<SelectTrigger
							className="h-11 w-44 bg-background md:h-9"
							aria-label={t("按反馈原因筛选", "Filter by reason")}
						>
							<SelectValue>
								{reasonFilter === "all"
									? t("全部原因", "All reasons")
									: ((reasonLabels as Record<string, string>)[reasonFilter] ??
										reasonFilter)}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">
								{t("全部原因", "All reasons")}
							</SelectItem>
							{ASK_FEEDBACK_REASON_CODES.map((code) => (
								<SelectItem key={code} value={code}>
									{reasonLabels[code]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Button
						type="button"
						variant="outline"
						size="icon"
						className="size-11 md:size-9"
						title={t("刷新", "Refresh")}
						aria-label={t("刷新", "Refresh")}
						disabled={loading}
						onClick={() => void load()}
					>
						<RefreshCw
							className={cn("size-3.5", loading && "motion-safe:animate-spin")}
							aria-hidden
						/>
					</Button>
					<Button
						type="button"
						variant="outline"
						className="h-11 md:h-9"
						disabled={items.length === 0}
						onClick={() => void exportJsonl()}
					>
						<Download className="size-3.5" aria-hidden />
						{t("导出黄金集骨架", "Export golden skeletons")}
					</Button>
				</div>
			</div>

			{error ? (
				<div
					role="alert"
					className="shrink-0 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
				>
					{error}
				</div>
			) : loading ? (
				<LedgerTableSkeleton
					rows={6}
					label={t("正在加载 Bad Case 队列…", "Loading bad-case queue…")}
				/>
			) : items.length === 0 ? (
				<div className="rounded-lg border border-border px-4 py-8 text-center text-sm text-muted-foreground">
					{t(
						"当前筛选条件下暂无 Bad Case 反馈。",
						"No bad-case feedback matches the current filters.",
					)}
				</div>
			) : (
				<LedgerTable
					header={
						<TableRow className="hover:bg-transparent">
							<TableHead className="w-[10rem] px-3">request_id</TableHead>
							<TableHead className="px-3">{t("原因", "Reason")}</TableHead>
							<TableHead className="px-3">
								{t("类型 / 状态", "Type / status")}
							</TableHead>
							<TableHead className="px-3">
								{t("引用 / 耗时", "Citations / latency")}
							</TableHead>
							<TableHead className="w-[12rem] px-3">
								{t("反馈时间", "Reported at")}
							</TableHead>
							<TableHead className="px-3">
								{t("治理状态", "Triage status")}
							</TableHead>
							<TableHead className="px-3 text-right">
								{t("操作", "Actions")}
							</TableHead>
						</TableRow>
					}
				>
					<TableBody>
						{items.map((item) => (
							<TableRow key={item.id}>
								<TableCell className="px-3 py-2.5 font-mono text-xs">
									{item.request_id.slice(0, 8)}…
								</TableCell>
								<TableCell className="px-3 py-2.5">
									{item.reason_code
										? reasonLabels[item.reason_code]
										: t("未选择原因", "No reason selected")}
								</TableCell>
								<TableCell className="px-3 py-2.5 text-xs text-muted-foreground">
									{item.query_type ?? "-"} · {item.run_status}
								</TableCell>
								<TableCell className="px-3 py-2.5 font-mono text-xs tabular-nums text-muted-foreground">
									{t(
										`${item.citation_count} 条`,
										`${item.citation_count} ${item.citation_count === 1 ? "citation" : "citations"}`,
									)}{" "}
									·{" "}
									{item.latency_ms != null
										? formatDurationMs(item.latency_ms)
										: "-"}
								</TableCell>
								<TableCell className="px-3 py-2.5 text-xs tabular-nums text-muted-foreground">
									{formatDateTime(item.updated_at)}
								</TableCell>
								<TableCell className="px-3 py-2.5">
									<span
										className={cn(
											"inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium",
											TRIAGE_BADGE_CLASSES[item.triage_status],
										)}
									>
										{triageLabels[item.triage_status]}
									</span>
								</TableCell>
								<TableCell className="px-3 py-2.5 text-right">
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
												{t("标记已确认", "Mark resolved")}
											</Button>
										) : (
											<Button
												type="button"
												variant="ghost"
												size="sm"
												disabled={updatingId === item.id}
												onClick={() => void handleTriageChange(item.id, "open")}
											>
												{t("重新打开", "Reopen")}
											</Button>
										)}
									</div>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</LedgerTable>
			)}
		</section>
	);
}
