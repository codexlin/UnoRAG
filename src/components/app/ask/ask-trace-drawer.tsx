"use client";

import {
	Check,
	CheckCircle2,
	CircleAlert,
	CircleHelp,
	Code2,
	Copy,
	ListTree,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { RetrievalInspectionPanel } from "@/components/app/ask/retrieval-inspection-panel";
import { ModelUsagePanel } from "@/components/app/model-usage-panel";
import {
	StageWaterfall,
	stageDisplayName,
} from "@/components/app/stage-waterfall";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	Trace,
	TraceCollapsible,
	TraceCollapsibleContent,
	TraceCollapsibleTrigger,
	TraceDescription,
	TraceIcon,
	TraceLine,
	TraceTitle,
} from "@/components/ui/trace";
import { projectModelUsage } from "@/core/ai/model-usage";
import { projectRerankDiagnostic } from "@/core/retrieval/provider-request";
import type {
	ApiAskStage,
	ApiAskTraceDetails,
	ApiRetrievalDebug,
} from "@/lib/api";
import { formatDurationMs } from "@/lib/format";
import { useInterfaceLanguage, useInterfaceText } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

function formatDebugValue(
	value: unknown,
	t: ReturnType<typeof useInterfaceText>,
): string {
	if (value == null) return "—";
	if (typeof value === "boolean") return value ? t("是", "Yes") : t("否", "No");
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return "—";
		return Number.isInteger(value) ? String(value) : value.toFixed(3);
	}
	if (typeof value === "string") return value || "—";
	if (Array.isArray(value)) {
		if (value.length === 0) return "—";
		return value.map((item) => formatDebugValue(item, t)).join(", ");
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** Server-side stage duration from retrieval_debug.stages */
export function stageDurationMs(
	debug: ApiRetrievalDebug | null | undefined,
	stageName: string,
): number | null {
	const stages = Array.isArray(debug?.stages) ? debug.stages : [];
	const hit = stages.find((s) => s.stage === stageName);
	if (
		!hit ||
		typeof hit.duration_ms !== "number" ||
		Number.isNaN(hit.duration_ms)
	) {
		return null;
	}
	return hit.duration_ms;
}

function serverTotalDurationMs(
	debug: ApiRetrievalDebug | null | undefined,
): number | null {
	if (
		typeof debug?.total_duration_ms === "number" &&
		!Number.isNaN(debug.total_duration_ms)
	) {
		return debug.total_duration_ms;
	}
	return null;
}

function TraceFields({ rows }: { rows: [string, unknown][] }) {
	const t = useInterfaceText();
	return (
		<dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-2 text-xs">
			{rows.map(([label, value]) => (
				<div key={label} className="contents">
					<dt className="[overflow-wrap:anywhere]">{label}</dt>
					<dd className="text-foreground [overflow-wrap:anywhere]">
						{formatDebugValue(value, t)}
					</dd>
				</div>
			))}
		</dl>
	);
}

function TraceSection({
	title,
	defaultOpen,
	children,
}: {
	title: string;
	defaultOpen?: boolean;
	children: ReactNode;
}) {
	return (
		<TraceCollapsible defaultOpen={defaultOpen} className="border-b">
			<h3>
				<TraceCollapsibleTrigger className="w-full justify-between px-2 font-medium text-foreground hover:bg-muted/40">
					{title}
				</TraceCollapsibleTrigger>
			</h3>
			<TraceCollapsibleContent className="m-0 space-y-4 border-l-0 px-2 pt-2 pb-4">
				{children}
			</TraceCollapsibleContent>
		</TraceCollapsible>
	);
}

const RERANK_CATEGORY_LABELS = {
	success: ["成功", "Succeeded"],
	timeout: ["请求超时", "Request timed out"],
	http: ["上游 HTTP 错误", "Upstream HTTP error"],
	transport: ["传输失败", "Transport failure"],
	invalid_response: ["响应无效", "Invalid response"],
	unknown: ["未分类错误", "Unclassified error"],
} as const;

function StageTraceDetails({ stage }: { stage: ApiAskStage }) {
	const t = useInterfaceText();
	const { locale } = useInterfaceLanguage();
	const failed = stage.ok === false;
	const outcome = failed
		? t("失败", "Failed")
		: stage.ok === true
			? t("完成", "Completed")
			: t("未记录", "Not recorded");
	const Icon = failed
		? CircleAlert
		: stage.ok === true
			? CheckCircle2
			: CircleHelp;
	const duration =
		Number.isFinite(stage.duration_ms) && stage.duration_ms >= 0
			? formatDurationMs(stage.duration_ms)
			: t("未记录", "Not recorded");
	const rerank = projectRerankDiagnostic(
		"rerank_diagnostic" in stage
			? stage.rerank_diagnostic
			: stage.detail?.rerankDiagnostic,
	);
	const fields = [
		{ label: t("阶段键", "Stage key"), value: stage.stage },
		{ label: t("执行结果", "Outcome"), value: outcome },
		...(rerank
			? [
					{
						label: t("重排结果", "Rerank outcome"),
						value: t(
							RERANK_CATEGORY_LABELS[rerank.category][0],
							RERANK_CATEGORY_LABELS[rerank.category][1],
						),
					},
					{
						label: t("重排耗时", "Rerank duration"),
						value: formatDurationMs(rerank.durationMs),
					},
					{
						label: t("HTTP 状态", "HTTP status"),
						value: formatDebugValue(rerank.statusCode, t),
					},
					{
						label: t("尝试 / 上限", "Attempts / Max"),
						value: `${formatDebugValue(rerank.attempts, t)} / ${formatDebugValue(rerank.maxAttempts, t)}`,
					},
					{
						label: t("重排预算", "Rerank timeout"),
						value:
							rerank.timeoutMs == null
								? t("未记录", "Not recorded")
								: formatDurationMs(rerank.timeoutMs),
					},
					{
						label: t("输入 / 请求 / 返回", "Input / Requested / Returned"),
						value: `${rerank.inputCount} / ${rerank.requestedCount} / ${formatDebugValue(rerank.resultCount, t)}`,
					},
					{
						label: t(
							"候选 / 重排 / 去重 / TopK",
							"Candidates / Reranked / Deduped / TopK",
						),
						value: `${rerank.candidateCountBeforeRerank} → ${rerank.candidateCountAfterRerank} → ${rerank.candidateCountAfterDedup} → ${rerank.candidateCountAfterTopK}`,
					},
				]
			: []),
	];

	return (
		<TraceCollapsible defaultOpen={failed}>
			<TraceCollapsibleTrigger className="w-full gap-2 px-2 hover:bg-muted/40">
				<TraceLine
					status={failed ? "error" : undefined}
					className="w-full flex-1"
				>
					<TraceIcon className={cn(!failed && "text-muted-foreground")}>
						<Icon />
					</TraceIcon>
					<TraceTitle className="flex-1 whitespace-normal [overflow-wrap:anywhere]">
						{stageDisplayName(stage.stage, locale)}
					</TraceTitle>
					<span className="sr-only">{outcome}</span>
					<TraceDescription className="pl-2 font-mono text-xs text-muted-foreground">
						{duration}
					</TraceDescription>
				</TraceLine>
			</TraceCollapsibleTrigger>
			<TraceCollapsibleContent className="mt-0 mb-3 mr-2">
				<dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-2 text-xs">
					{fields.map((field) => (
						<div key={field.label} className="contents">
							<dt className="[overflow-wrap:anywhere]">{field.label}</dt>
							<dd className="font-mono text-foreground [overflow-wrap:anywhere]">
								{field.value}
							</dd>
						</div>
					))}
				</dl>
			</TraceCollapsibleContent>
		</TraceCollapsible>
	);
}

function CopyTraceId({ traceId }: { traceId: string }) {
	const t = useInterfaceText();
	const [copied, setCopied] = useState(false);
	const timer = useRef<number | null>(null);
	const active = useRef(false);
	const copying = useRef(false);
	useEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
			if (timer.current != null) window.clearTimeout(timer.current);
		};
	}, []);

	async function onCopy() {
		if (copying.current) return;
		copying.current = true;
		try {
			await navigator.clipboard.writeText(traceId);
			if (!active.current) return;
			setCopied(true);
			if (timer.current != null) window.clearTimeout(timer.current);
			timer.current = window.setTimeout(() => setCopied(false), 1400);
		} catch {
			if (!active.current) return;
			setCopied(false);
			toast.error(t("复制失败", "Copy failed"));
		} finally {
			copying.current = false;
		}
	}

	return (
		<div className="flex min-w-0 items-center gap-2 border-b py-1">
			<code className="min-w-0 flex-1 text-xs text-foreground [overflow-wrap:anywhere]">
				{traceId}
			</code>
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className={cn(
								"size-11 shrink-0 text-muted-foreground transition-colors duration-150 hover:text-foreground motion-reduce:transition-none",
								copied && "text-primary hover:text-primary",
							)}
							aria-label={
								copied
									? t("已复制 trace_id", "Copied trace_id")
									: t("复制 trace_id", "Copy trace_id")
							}
							onClick={() => void onCopy()}
						/>
					}
				>
					{copied ? (
						<Check className="size-4" aria-hidden />
					) : (
						<Copy className="size-4" aria-hidden />
					)}
				</TooltipTrigger>
				<TooltipContent>
					{copied ? t("已复制", "Copied") : t("复制 trace_id", "Copy trace_id")}
				</TooltipContent>
			</Tooltip>
			<span className="sr-only" role="status">
				{copied ? t("链路标识已复制", "Trace ID copied") : ""}
			</span>
		</div>
	);
}

export function hasAskTrace(debug?: ApiRetrievalDebug | null): boolean {
	if (!debug || typeof debug !== "object") return false;
	if (debug.model_usage != null) return true;
	const stages = debug.stages;
	if (Array.isArray(stages) && stages.length > 0) return true;
	return typeof debug.trace_id === "string" && debug.trace_id.length > 0;
}

export function AskTraceDrawerContent({
	debug,
	details: liveDetails,
	canInspect,
}: {
	debug: ApiRetrievalDebug;
	details?: ApiAskTraceDetails;
	canInspect: boolean;
}) {
	const t = useInterfaceText();
	const details = canInspect ? liveDetails : undefined;
	const stages = Array.isArray(debug.stages) ? debug.stages : [];
	const modelUsage = projectModelUsage(debug.model_usage);
	const traceId = debug.trace_id || null;
	const rawJson = JSON.stringify(debug, null, 2);
	const judge = details?.judge_summary;
	const judgeMs = debug.judge_duration_ms;
	const retrieveMs = stageDurationMs(debug, "retrieve");
	const overview: [string, unknown][] = [
		[t("执行路径", "Path"), debug.path],
		[t("路由", "Route"), debug.route ?? debug.query_type],
		[t("路由原因", "Route reason"), debug.route_reason],
		[t("检索模式", "Retrieval mode"), debug.retrieval_mode],
		[
			t("混合检索", "Hybrid retrieval"),
			debug.hybrid_failed ? t("已降级", "Fell back") : debug.used_hybrid,
		],
		[
			t("重排", "Rerank"),
			debug.rerank_failed ? t("已降级", "Fell back") : debug.used_rerank,
		],
		[t("精确路径判定", "Precise routing gate"), debug.precise_gate],
		[t("升级", "Upgrade"), debug.upgrade],
	];
	if (debug.upgrade_reason)
		overview.push([t("升级原因", "Upgrade reason"), debug.upgrade_reason]);
	if (debug.downgrade_reason)
		overview.push([t("降级原因", "Downgrade reason"), debug.downgrade_reason]);
	if (details?.rewritten_question)
		overview.push([
			t("改写后的问题", "Rewritten question"),
			details.rewritten_question,
		]);

	return (
		<ScrollArea
			className="min-h-0 flex-1"
			contentClassName="flex flex-col px-3 pb-5 sm:px-5"
		>
			<TraceSection
				title={t("执行总览与决策链", "Overview and routing")}
				defaultOpen
			>
				<TraceFields rows={overview} />
				<div>
					<p className="text-xs">trace_id</p>
					{traceId ? <CopyTraceId key={traceId} traceId={traceId} /> : <p>—</p>}
				</div>
			</TraceSection>
			{canInspect ? (
				<TraceSection
					title={t(
						"检索透视 · 粗召回与重排",
						"Retrieval funnel · Coarse vs rerank",
					)}
					defaultOpen
				>
					{details ? (
						<RetrievalInspectionPanel
							key={traceId}
							details={details}
							traceId={traceId}
						/>
					) : (
						<p className="text-sm text-muted-foreground">
							{t(
								"本轮没有可用的检索透视。提问前开启「检索透视」，即可查看本次会话的粗召回和重排。",
								"No retrieval snapshot is available for this turn. Enable Retrieval trace before asking to inspect coarse retrieval and reranking.",
							)}
						</p>
					)}
				</TraceSection>
			) : null}
			<TraceSection
				title={t(
					"证据裁决与引用校验",
					"Evidence judgment and citation validation",
				)}
			>
				<TraceFields
					rows={[
						[t("裁决模式", "Judge mode"), judge?.mode ?? debug.judge_mode],
						[t("裁决结果", "Verdict"), judge?.verdict],
						[t("证据充分", "Sufficient evidence"), judge?.sufficient],
						[
							t("冲突状态", "Conflict status"),
							judge?.conflict_status ?? debug.evidence_resolution,
						],
						[
							t("引用校验", "Citation validation"),
							judge &&
								(judge.citation_validation === "passed"
									? t("通过", "Passed")
									: t("未检查", "Not checked")),
						],
						[t("裁决模型", "Judge model"), debug.judge_model],
					]}
				/>
			</TraceSection>
			<TraceSection
				title={t("性能与模型用量", "Performance and model usage")}
				defaultOpen={!details}
			>
				<TraceFields
					rows={[
						[
							t("服务端检索耗时", "Server retrieval"),
							retrieveMs !== null ? formatDurationMs(retrieveMs) : null,
						],
						[
							t("裁决耗时", "Judge duration"),
							typeof judgeMs === "number" ? formatDurationMs(judgeMs) : null,
						],
						...(!modelUsage &&
						(typeof debug.judge_input_tokens === "number" ||
							typeof debug.judge_output_tokens === "number")
							? [
									[
										t("裁决 Token（旧记录）", "Judge tokens (legacy)"),
										`${formatDebugValue(debug.judge_input_tokens, t)} / ${formatDebugValue(debug.judge_output_tokens, t)}`,
									] as [string, string],
								]
							: []),
					]}
				/>
				<section
					className="space-y-3"
					aria-label={t("阶段耗时", "Stage timings")}
				>
					<div className="flex flex-wrap items-baseline justify-between gap-2">
						<h3 className="text-sm font-medium">
							{t("阶段耗时", "Stage timings")}
						</h3>
						<span className="text-xs text-muted-foreground">
							{t(
								`${stages.length} 步 · 顺序累计`,
								`${stages.length} ${stages.length === 1 ? "step" : "steps"} · cumulative`,
							)}
						</span>
					</div>
					{stages.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							{t("暂无阶段记录", "No stage records")}
						</p>
					) : (
						<StageWaterfall stages={stages} />
					)}
				</section>
				{stages.length > 0 ? (
					<section aria-label={t("阶段详情", "Stage details")}>
						<Trace key={traceId}>
							<TraceCollapsible
								defaultOpen={stages.some((stage) => stage.ok === false)}
							>
								<TraceCollapsibleTrigger className="w-full gap-2 px-2 hover:bg-muted/40">
									<TraceLine className="w-full flex-1">
										<TraceIcon>
											<ListTree />
										</TraceIcon>
										<TraceTitle className="flex-1 font-medium text-foreground">
											{t("阶段详情", "Stage details")}
										</TraceTitle>
										<TraceDescription className="text-xs text-muted-foreground">
											{t(
												`${stages.length} 项`,
												`${stages.length} ${stages.length === 1 ? "item" : "items"}`,
											)}
										</TraceDescription>
									</TraceLine>
								</TraceCollapsibleTrigger>
								<TraceCollapsibleContent className="mt-0 mb-0 pr-0 pl-3">
									<Trace className="gap-0">
										{stages.map((stage, index) => (
											<StageTraceDetails
												// biome-ignore lint/suspicious/noArrayIndexKey: Ordered stage records have no ID and stage names may repeat.
												key={`${stage.stage}:${index}`}
												stage={stage}
											/>
										))}
									</Trace>
								</TraceCollapsibleContent>
							</TraceCollapsible>
						</Trace>
					</section>
				) : null}
				<ModelUsagePanel usage={modelUsage} />
				<Trace className="border-t border-border/70 pt-2">
					<TraceCollapsible>
						<TraceCollapsibleTrigger className="w-full justify-between px-2 hover:bg-muted/40">
							<TraceLine>
								<TraceIcon>
									<Code2 />
								</TraceIcon>
								<TraceTitle>{t("原始 JSON", "Raw JSON")}</TraceTitle>
							</TraceLine>
						</TraceCollapsibleTrigger>
						<TraceCollapsibleContent className="m-0 border-l-0 p-0">
							<section
								// biome-ignore lint/a11y/noNoninteractiveTabindex: The scrollable JSON region needs keyboard access.
								tabIndex={0}
								aria-label={t("原始 JSON 内容", "Raw JSON content")}
								className="max-h-64 overflow-auto rounded-md bg-muted/30 px-3 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								<pre className="font-mono text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap break-all">
									{rawJson}
								</pre>
							</section>
						</TraceCollapsibleContent>
					</TraceCollapsible>
				</Trace>
			</TraceSection>
		</ScrollArea>
	);
}

export function AskTraceDrawer({
	open,
	onOpenChange,
	debug,
	details,
	canInspect,
	clientDurationMs = null,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	debug: ApiRetrievalDebug | null;
	details?: ApiAskTraceDetails;
	canInspect: boolean;
	/** Browser wall-clock until done, for reconciling with server total. */
	clientDurationMs?: number | null;
}) {
	const t = useInterfaceText();
	const titleRef = useRef<HTMLHeadingElement | null>(null);
	const serverTotal = serverTotalDurationMs(debug);

	return (
		<Sheet open={open && debug != null} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				initialFocus={titleRef}
				className="w-full max-w-[min(100vw,40rem)]! gap-0 motion-reduce:transition-none [&>[data-slot=sheet-close]]:size-11"
				showCloseButton
			>
				{debug ? (
					<>
						<SheetHeader className="border-b px-5 py-5 sm:px-6">
							<SheetTitle ref={titleRef} tabIndex={-1} className="pr-8">
								{t("请求链路", "Request trace")}
							</SheetTitle>
							<SheetDescription>
								{[
									serverTotal != null
										? t(
												`服务端合计 ${formatDurationMs(serverTotal)}`,
												`Server total ${formatDurationMs(serverTotal)}`,
											)
										: null,
									clientDurationMs != null
										? t(
												`端到端 ${formatDurationMs(clientDurationMs)}`,
												`End-to-end ${formatDurationMs(clientDurationMs)}`,
											)
										: null,
								]
									.filter(Boolean)
									.join(" · ") || t("本次请求", "Current request")}
							</SheetDescription>
						</SheetHeader>
						<AskTraceDrawerContent
							debug={debug}
							details={details}
							canInspect={canInspect}
						/>
					</>
				) : null}
			</SheetContent>
		</Sheet>
	);
}
