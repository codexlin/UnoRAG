"use client";

import { useQuery } from "@tanstack/react-query";
import {
	Check,
	Copy,
	ExternalLink,
	LoaderCircle,
	RotateCcw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ModelUsagePanel } from "@/components/app/model-usage-panel";
import { englishOperationsGuidance } from "@/components/app/operations-guidance";
import { useSession } from "@/components/app/session-provider";
import { StageWaterfall } from "@/components/app/stage-waterfall";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { retryJob } from "@/lib/api";
import { formatDateTime, formatDurationMs } from "@/lib/format";
import { useInterfaceLanguage, useInterfaceText } from "@/lib/i18n/provider";
import type { OperationsEventDetail } from "@/lib/operations-event-detail";
import { queryKeys } from "@/lib/query-keys";

export type OperationsErrorRef = {
	id: string;
	source: "ask" | "job";
};

function rerankCategoryLabels(t: ReturnType<typeof useInterfaceText>) {
	return {
		success: t("成功", "Succeeded"),
		timeout: t("请求超时", "Timed out"),
		http: t("上游 HTTP 错误", "Upstream HTTP error"),
		transport: t("传输失败", "Transport error"),
		invalid_response: t("响应无效", "Invalid response"),
		unknown: t("未分类错误", "Unclassified error"),
	} as const;
}

export function RequestOutcome({ detail }: { detail: OperationsEventDetail }) {
	const t = useInterfaceText();
	const { locale } = useInterfaceLanguage();
	const statusLabels: Record<string, string> = {
		running: t("处理中", "Running"),
		completed: t("已完成", "Completed"),
		refused: t("已拒答", "Refused"),
		failed: t("失败", "Failed"),
		cancelled: t("已取消", "Cancelled"),
	};
	const faulty =
		detail.status === "failed" ||
		(detail.status === "completed" && detail.error_code != null);
	const showGuidance =
		faulty || (detail.source === "job" && detail.error_code != null);
	const guidance =
		locale === "en"
			? englishOperationsGuidance(detail.error_code)
			: detail.guidance;
	return (
		<section
			className={
				faulty
					? "border border-destructive/30 bg-destructive/5 px-3 py-3"
					: "border border-border/70 bg-muted/25 px-3 py-3"
			}
		>
			<p className="text-ui font-medium">
				{statusLabels[detail.status] ?? detail.status}
			</p>
			{showGuidance ? (
				<div className="mt-2 space-y-2">
					<p className="text-ui font-medium">{guidance.title}</p>
					<p className="font-mono text-xs text-destructive break-all">
						{detail.error_code ?? "unclassified_error"}
					</p>
					<p className="text-ui text-foreground/85">{guidance.cause}</p>
					<p className="text-ui text-muted-foreground">{guidance.recovery}</p>
				</div>
			) : null}
			{detail.ask ? (
				<dl className="mt-3 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
					{[
						[t("问题类型", "Query type"), detail.query_type ?? "—"],
						[t("检索模式", "Retrieval mode"), detail.retrieval_mode ?? "—"],
						[
							t("混合检索", "Hybrid search"),
							detail.ask.used_hybrid ? t("是", "Yes") : t("否", "No"),
						],
						[
							t("重排", "Rerank"),
							detail.ask.used_rerank ? t("是", "Yes") : t("否", "No"),
						],
						[t("引用数", "Citations"), String(detail.ask.citation_count)],
						[t("拒答原因", "Refusal reason"), detail.ask.refuse_reason ?? "—"],
					].map(([label, value]) => (
						<div className="contents" key={label}>
							<dt className="text-muted-foreground">{label}</dt>
							<dd className="min-w-0 break-all font-mono text-xs">{value}</dd>
						</div>
					))}
				</dl>
			) : null}
		</section>
	);
}

export function CitationDiagnostics({
	stages,
}: {
	stages: OperationsEventDetail["stages"];
}) {
	const t = useInterfaceText();
	const labels = {
		unknown_source: t(
			"来源编号不在本次清单",
			"Source number not in allowed list",
		),
		invalid_format: t("引用格式不合法", "Invalid citation format"),
		incomplete_marker: t("引用标记未闭合", "Unclosed citation marker"),
		marker_too_long: t(
			"引用标记超过长度限制",
			"Citation marker exceeds length limit",
		),
	};
	return stages.map((stage) => {
		const diagnostic = stage.detail?.citation;
		if (!diagnostic) return null;
		return (
			<section key={stage.id} className="border-t border-border/70 pt-4">
				<h3 className="text-ui font-medium">
					{t(
						`引用诊断 · 阶段 ${stage.sequence}`,
						`Citation diagnostics · Stage ${stage.sequence}`,
					)}
				</h3>
				<dl className="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2">
					<dt className="text-xs text-muted-foreground">
						{t("拦截原因", "Block reason")}
					</dt>
					<dd className="min-w-0 break-words text-xs">
						{labels[diagnostic.category]}
					</dd>
					<dt className="text-xs text-muted-foreground">
						{t("可用来源数", "Allowed sources")}
					</dt>
					<dd className="font-mono text-xs">{diagnostic.allowedSourceCount}</dd>
				</dl>
			</section>
		);
	});
}

export function JudgeDiagnostics({
	stages,
}: {
	stages: OperationsEventDetail["stages"];
}) {
	const t = useInterfaceText();
	return stages.map((stage) => {
		if (
			stage.stage !== "judge" ||
			stage.error_code !== "judge_unavailable" ||
			!stage.detail
		)
			return null;
		const detail = stage.detail;
		const fields = [
			[t("故障类别", "Error category"), detail.judge_error_category],
			[t("故障来源", "Failure source"), detail.judge_failure_source],
			[t("失败环节", "Failed stage"), detail.judge_failed_stage],
			[t("校验原因", "Validation code"), detail.judge_validation_code],
			[t("应用层尝试次数", "App attempts"), detail.judge_attempts],
			[t("应用层尝试上限", "Max app attempts"), detail.judge_max_attempts],
			[
				t("单次超时", "Attempt timeout"),
				detail.judge_timeout_ms == null
					? null
					: `${detail.judge_timeout_ms} ms`,
			],
			[
				t("总预算", "Total budget"),
				detail.judge_budget_ms == null ? null : `${detail.judge_budget_ms} ms`,
			],
			[
				t("实际耗时", "Actual duration"),
				detail.judge_duration_ms == null
					? null
					: `${detail.judge_duration_ms} ms`,
			],
			[t("HTTP 状态", "HTTP status"), detail.judge_status_code],
			[
				t("充分性已完成尝试", "Sufficiency attempts"),
				detail.judge_sufficiency_attempts,
			],
			[
				t("充分性已完成耗时", "Sufficiency duration"),
				detail.judge_sufficiency_duration_ms == null
					? null
					: `${detail.judge_sufficiency_duration_ms} ms`,
			],
			[
				t("拒答复核已完成尝试", "Refusal review attempts"),
				detail.judge_refusal_review_attempts,
			],
			[
				t("拒答复核已完成耗时", "Refusal review duration"),
				detail.judge_refusal_review_duration_ms == null
					? null
					: `${detail.judge_refusal_review_duration_ms} ms`,
			],
			[
				t("冲突核验已完成尝试", "Conflict check attempts"),
				detail.judge_conflict_attempts,
			],
			[
				t("冲突核验已完成耗时", "Conflict check duration"),
				detail.judge_conflict_duration_ms == null
					? null
					: `${detail.judge_conflict_duration_ms} ms`,
			],
			[
				t("可重试", "Retryable"),
				detail.judge_retryable == null
					? null
					: detail.judge_retryable
						? t("是", "Yes")
						: t("否", "No"),
			],
		].filter((field) => field[1] != null);
		if (fields.length === 0) return null;
		return (
			<section key={stage.id} className="border-t border-border/70 pt-4">
				<h3 className="text-ui font-medium">
					{t(
						`Judge 诊断 · 阶段 ${stage.sequence}`,
						`Judge diagnostics · Stage ${stage.sequence}`,
					)}
				</h3>
				<dl className="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2">
					{fields.map(([label, value]) => (
						<div key={label} className="contents">
							<dt className="text-xs text-muted-foreground">{label}</dt>
							<dd className="min-w-0 break-words font-mono text-xs">{value}</dd>
						</div>
					))}
				</dl>
			</section>
		);
	});
}

export function RerankDiagnostics({
	stages,
}: {
	stages: OperationsEventDetail["stages"];
}) {
	const t = useInterfaceText();
	const categoryLabels = rerankCategoryLabels(t);
	return stages.map((stage) => {
		const diagnostic =
			stage.stage === "retrieve" || stage.stage === "table_retrieve"
				? stage.detail?.rerank
				: null;
		if (!diagnostic) return null;
		const fields = [
			[t("执行结果", "Outcome"), categoryLabels[diagnostic.category]],
			[t("HTTP 状态", "HTTP status"), diagnostic.statusCode],
			[t("尝试次数", "Attempts"), diagnostic.attempts],
			[
				t("总预算", "Total budget"),
				diagnostic.timeoutMs == null ? null : `${diagnostic.timeoutMs} ms`,
			],
			[t("实际耗时", "Actual duration"), `${diagnostic.durationMs} ms`],
			[
				t("候选 / 返回", "Input / returned"),
				`${diagnostic.inputCount} / ${diagnostic.resultCount ?? "—"}`,
			],
			[
				t("图像记录", "Figure counts"),
				`${diagnostic.figureCountBeforeRerank} → ${diagnostic.figureCountAfterRerank} → ${diagnostic.figureCountAfterDedup} → ${diagnostic.figureCountAfterTopK}`,
			],
		].filter((field) => field[1] != null);
		return (
			<section key={stage.id} className="border-t border-border/70 pt-4">
				<h3 className="text-ui font-medium">
					{t(
						`重排诊断 · 阶段 ${stage.sequence}`,
						`Rerank diagnostics · Stage ${stage.sequence}`,
					)}
				</h3>
				<dl className="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2">
					{fields.map(([label, value]) => (
						<div key={label} className="contents">
							<dt className="text-xs text-muted-foreground">{label}</dt>
							<dd className="min-w-0 break-words font-mono text-xs">{value}</dd>
						</div>
					))}
				</dl>
			</section>
		);
	});
}

export function QdrantDiagnostics({
	stages,
}: {
	stages: OperationsEventDetail["stages"];
}) {
	const t = useInterfaceText();
	const labels = {
		...rerankCategoryLabels(t),
		cancelled: t("已取消", "Cancelled"),
	};
	return stages.map((stage) => {
		const diagnostic = stage.detail?.qdrant;
		if (!diagnostic) return null;
		const fields = [
			[t("操作", "Operation"), diagnostic.operation],
			[t("错误类别", "Error category"), labels[diagnostic.category]],
			[t("HTTP 状态", "HTTP status"), diagnostic.statusCode],
			[t("连接错误码", "Transport code"), diagnostic.transportCode],
			[
				t("可重试", "Retryable"),
				diagnostic.retryable ? t("是", "Yes") : t("否", "No"),
			],
			[t("尝试次数", "Attempts"), diagnostic.attempts],
			[t("调用耗时", "Call duration"), `${diagnostic.durationMs} ms`],
			[
				t("客户端超时", "Client timeout"),
				diagnostic.timeoutMs == null ? null : `${diagnostic.timeoutMs} ms`,
			],
		].filter((field) => field[1] != null);
		return (
			<section key={stage.id} className="border-t border-border/70 pt-4">
				<h3 className="text-ui font-medium">
					{t("Qdrant 诊断", "Qdrant diagnostics")}
				</h3>
				<dl className="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2">
					{fields.map(([label, value]) => (
						<div key={label} className="contents">
							<dt className="text-xs text-muted-foreground">{label}</dt>
							<dd className="min-w-0 break-words font-mono text-xs">{value}</dd>
						</div>
					))}
				</dl>
			</section>
		);
	});
}

function CopyValue({ value }: { value: string }) {
	const t = useInterfaceText();
	const [copied, setCopied] = useState(false);
	const timer = useRef<number | null>(null);
	useEffect(
		() => () => {
			if (timer.current != null) window.clearTimeout(timer.current);
		},
		[],
	);
	return (
		<div className="flex min-w-0 items-center gap-2">
			<code className="min-w-0 flex-1 text-xs [overflow-wrap:anywhere]">
				{value}
			</code>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				className="size-11 shrink-0"
				onClick={async () => {
					try {
						await navigator.clipboard.writeText(value);
						setCopied(true);
						if (timer.current != null) window.clearTimeout(timer.current);
						timer.current = window.setTimeout(() => setCopied(false), 1_200);
					} catch {
						setCopied(false);
						toast.error(t("复制失败", "Couldn't copy"));
					}
				}}
				aria-label={
					copied
						? t("已复制标识", "Identifier copied")
						: t("复制标识", "Copy identifier")
				}
				title={t("复制标识", "Copy identifier")}
			>
				{copied ? (
					<Check className="size-3 shrink-0 text-cite" />
				) : (
					<Copy className="size-3 shrink-0 text-muted-foreground" />
				)}
			</Button>
		</div>
	);
}

export function OperationsErrorDrawer({
	selected,
	onOpenChange,
	onRecovered,
}: {
	selected: OperationsErrorRef | null;
	onOpenChange: (open: boolean) => void;
	onRecovered?: () => void;
}) {
	const t = useInterfaceText();
	const { identity, can } = useSession();
	const [retrying, setRetrying] = useState(false);
	const titleRef = useRef<HTMLHeadingElement | null>(null);
	const query = useQuery({
		queryKey: queryKeys.operationEvent(
			{ organizationId: identity.tenantId, workspaceId: identity.workspaceId },
			selected?.source ?? "",
			selected?.id ?? "",
		),
		enabled: selected != null && can("manageMembers"),
		queryFn: async ({ signal }) => {
			if (!selected) throw new Error("event_not_selected");
			const response = await fetch(
				`/api/workspace/operations/events/${selected.source}/${encodeURIComponent(selected.id)}`,
				{ cache: "no-store", signal },
			);
			if (!response.ok) throw new Error(`event_http_${response.status}`);
			return (await response.json()) as OperationsEventDetail;
		},
		staleTime: 0,
		retry: false,
		refetchInterval: (current) =>
			current.state.data?.status === "running" ? 5_000 : false,
	});
	const detail = query.data;
	const error = query.isError;

	const identifiers = detail
		? [
				["Request ID", detail.request_id],
				["OTel Trace", detail.otel_trace_id],
				["Workflow", detail.workflow_id],
				["Job", detail.resource_id],
				[t("文档版本", "Document version"), detail.document_version_id],
			].filter((item): item is [string, string] => Boolean(item[1]))
		: [];

	return (
		<Sheet open={selected != null} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				initialFocus={titleRef}
				className="w-full max-w-[min(100vw,40rem)]! gap-0 [&>[data-slot=sheet-close]]:size-11"
				showCloseButton
			>
				<SheetHeader className="border-b border-border px-5 py-5 sm:px-6">
					<SheetTitle ref={titleRef} tabIndex={-1} className="pr-8">
						{selected?.source === "ask"
							? t("请求链路", "Request trace")
							: t("故障诊断", "Failure diagnostics")}
					</SheetTitle>
					<SheetDescription>
						{selected?.source === "ask"
							? t("Ask · 阶段耗时与执行结果", "Ask · Stage latency and outcome")
							: t(
									"Job · 阶段耗时与恢复动作",
									"Job · Stage latency and recovery",
								)}
					</SheetDescription>
				</SheetHeader>
				<ScrollArea
					className="min-h-0 flex-1"
					contentClassName="px-5 py-5 sm:px-6"
				>
					{!detail && !error ? (
						<div className="flex items-center gap-2 py-8 text-ui text-muted-foreground">
							<LoaderCircle className="size-4 animate-spin" />{" "}
							{t("正在关联诊断信息", "Loading diagnostic details")}
						</div>
					) : error ? (
						<div
							className="space-y-3 py-8 text-ui text-destructive"
							role="alert"
						>
							<p>
								{t(
									"详情暂时不可用，记录可能已被清理或当前无权访问。",
									"Details are temporarily unavailable. The record may have been pruned or you may not have access.",
								)}
							</p>
							<button
								type="button"
								className="inline-flex min-h-11 items-center gap-2 text-sm"
								onClick={() => void query.refetch()}
							>
								<RotateCcw className="size-3.5" />
								{t("重新加载", "Reload")}
							</button>
						</div>
					) : detail ? (
						<div className="space-y-5">
							<RequestOutcome detail={detail} />
							<section>
								<div className="mb-2 flex items-baseline justify-between">
									<h3 className="text-ui font-medium">
										{t("阶段耗时", "Stage latency")}
									</h3>
									<span className="font-mono text-xs text-muted-foreground">
										{detail.latency_ms == null
											? t(
													`${detail.stages.length} 步`,
													`${detail.stages.length} ${detail.stages.length === 1 ? "step" : "steps"}`,
												)
											: formatDurationMs(detail.latency_ms)}
									</span>
								</div>
								<p className="mb-3 text-xs text-muted-foreground">
									{t(
										`${detail.stages.length} 步 · 顺序累计`,
										`${detail.stages.length} ${detail.stages.length === 1 ? "step" : "steps"} · sequential`,
									)}
								</p>
								<StageWaterfall stages={detail.stages} />
							</section>
							{detail.source === "ask" ? (
								<ModelUsagePanel usage={detail.ask?.model_usage} />
							) : null}
							{detail.message || detail.can_retry ? (
								<section>
									{detail.message ? (
										<pre className="mt-3 max-h-32 overflow-auto border-t border-destructive/20 pt-3 font-mono text-xs whitespace-pre-wrap break-all text-muted-foreground">
											{detail.message}
										</pre>
									) : null}
									{detail.can_retry && detail.resource_id ? (
										<button
											type="button"
											disabled={retrying}
											onClick={async () => {
												setRetrying(true);
												try {
													await retryJob(detail.resource_id as string);
													toast.success(
														t(
															"已创建新的删除清理任务",
															"Created a new cleanup retry job",
														),
													);
													onRecovered?.();
												} catch (cause) {
													toast.error(
														cause instanceof Error
															? cause.message
															: t("重试清理失败", "Failed to retry cleanup"),
													);
												} finally {
													setRetrying(false);
												}
											}}
											className="mt-3 inline-flex min-h-11 items-center gap-1.5 border border-destructive/30 bg-background px-3 text-xs font-medium text-foreground hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
										>
											{retrying ? (
												<LoaderCircle className="size-3.5 animate-spin" />
											) : (
												<RotateCcw className="size-3.5" />
											)}
											{t("重试清理", "Retry cleanup")}
										</button>
									) : null}
								</section>
							) : null}

							<JudgeDiagnostics stages={detail.stages} />
							<CitationDiagnostics stages={detail.stages} />
							<RerankDiagnostics stages={detail.stages} />
							<QdrantDiagnostics stages={detail.stages} />

							<section className="border-t border-border/70 pt-4">
								<h3 className="text-ui font-medium">
									{t("关联信息", "Related metadata")}
								</h3>
								<dl className="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2">
									<div className="contents">
										<dt className="text-xs text-muted-foreground">
											{t("发生时间", "Timestamp")}
										</dt>
										<dd className="font-mono text-xs">
											{formatDateTime(detail.ended_at ?? detail.started_at)}
										</dd>
									</div>
									{identifiers.map(([label, value]) => (
										<div key={label} className="contents">
											<dt className="text-xs text-muted-foreground">{label}</dt>
											<dd className="min-w-0">
												<CopyValue key={value} value={value} />
											</dd>
										</div>
									))}
								</dl>
								{detail.library_id && detail.document_id ? (
									<a
										href="/app/libraries"
										className="mt-4 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-evidence hover:underline"
									>
										{t("打开知识库", "Open libraries")}{" "}
										<ExternalLink className="size-3" />
									</a>
								) : null}
							</section>
						</div>
					) : null}
				</ScrollArea>
			</SheetContent>
		</Sheet>
	);
}
