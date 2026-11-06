"use client";

import { useQuery } from "@tanstack/react-query";
import {
	Check,
	Copy,
	ExternalLink,
	LoaderCircle,
	RotateCcw,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useSession } from "@/components/app/session-provider";
import { StageWaterfall } from "@/components/app/stage-waterfall";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { retryJob } from "@/lib/api";
import { formatDateTime, formatDurationMs } from "@/lib/format";
import type { OperationsEventDetail } from "@/lib/operations-event-detail";
import { queryKeys } from "@/lib/query-keys";

export type OperationsErrorRef = {
	id: string;
	source: "ask" | "job";
};

const STATUS_LABELS: Record<string, string> = {
	running: "处理中",
	completed: "已完成",
	refused: "已拒答",
	failed: "失败",
	cancelled: "已取消",
};

export function RequestOutcome({ detail }: { detail: OperationsEventDetail }) {
	const faulty =
		detail.status === "failed" ||
		(detail.status === "completed" && detail.error_code != null);
	const showGuidance =
		faulty || (detail.source === "job" && detail.error_code != null);
	return (
		<section
			className={
				faulty
					? "border border-destructive/30 bg-destructive/5 px-3 py-3"
					: "border border-border/70 bg-muted/25 px-3 py-3"
			}
		>
			<p className="text-ui font-semibold">
				{STATUS_LABELS[detail.status] ?? detail.status}
			</p>
			{showGuidance ? (
				<div className="mt-2 space-y-2">
					<p className="text-ui font-medium">{detail.guidance.title}</p>
					<p className="font-mono text-[11px] text-destructive break-all">
						{detail.error_code ?? "unclassified_error"}
					</p>
					<p className="text-ui text-foreground/85">{detail.guidance.cause}</p>
					<p className="text-ui text-muted-foreground">
						{detail.guidance.recovery}
					</p>
				</div>
			) : null}
			{detail.ask ? (
				<dl className="mt-3 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
					{[
						["问题类型", detail.query_type ?? "—"],
						["检索模式", detail.retrieval_mode ?? "—"],
						["混合检索", detail.ask.used_hybrid ? "是" : "否"],
						["重排", detail.ask.used_rerank ? "是" : "否"],
						["引用数", String(detail.ask.citation_count)],
						["拒答原因", detail.ask.refuse_reason ?? "—"],
					].map(([label, value]) => (
						<div className="contents" key={label}>
							<dt className="text-muted-foreground">{label}</dt>
							<dd className="min-w-0 break-all font-mono text-[11px]">
								{value}
							</dd>
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
	const labels = {
		unknown_source: "来源编号不在本次清单",
		invalid_format: "引用格式不合法",
		incomplete_marker: "引用标记未闭合",
		marker_too_long: "引用标记超过长度限制",
	};
	return stages.map((stage) => {
		const diagnostic = stage.detail?.citation;
		if (!diagnostic) return null;
		return (
			<section key={stage.id} className="border-t border-border/70 pt-4">
				<h3 className="text-ui font-semibold">
					引用诊断 · 阶段 {stage.sequence}
				</h3>
				<dl className="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2">
					<dt className="text-meta text-muted-foreground">拦截原因</dt>
					<dd className="min-w-0 break-words text-xs">
						{labels[diagnostic.category]}
					</dd>
					<dt className="text-meta text-muted-foreground">可用来源数</dt>
					<dd className="font-mono text-[11px]">
						{diagnostic.allowedSourceCount}
					</dd>
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
	return stages.map((stage) => {
		if (
			stage.stage !== "judge" ||
			stage.error_code !== "judge_unavailable" ||
			!stage.detail
		)
			return null;
		const detail = stage.detail;
		const fields = [
			["故障类别", detail.judge_error_category],
			["应用层尝试次数", detail.judge_attempts],
			["应用层尝试上限", detail.judge_max_attempts],
			[
				"单次超时",
				detail.judge_timeout_ms == null
					? null
					: `${detail.judge_timeout_ms} ms`,
			],
			[
				"总预算",
				detail.judge_budget_ms == null ? null : `${detail.judge_budget_ms} ms`,
			],
			[
				"实际耗时",
				detail.judge_duration_ms == null
					? null
					: `${detail.judge_duration_ms} ms`,
			],
			["HTTP 状态", detail.judge_status_code],
			[
				"可重试",
				detail.judge_retryable == null
					? null
					: detail.judge_retryable
						? "是"
						: "否",
			],
		].filter((field) => field[1] != null);
		if (fields.length === 0) return null;
		return (
			<section key={stage.id} className="border-t border-border/70 pt-4">
				<h3 className="text-ui font-semibold">
					Judge 诊断 · 阶段 {stage.sequence}
				</h3>
				<dl className="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2">
					{fields.map(([label, value]) => (
						<div key={label} className="contents">
							<dt className="text-meta text-muted-foreground">{label}</dt>
							<dd className="min-w-0 break-words font-mono text-[11px]">
								{value}
							</dd>
						</div>
					))}
				</dl>
			</section>
		);
	});
}

const RERANK_CATEGORY_LABELS = {
	success: "成功",
	timeout: "请求超时",
	http: "上游 HTTP 错误",
	transport: "传输失败",
	invalid_response: "响应无效",
	unknown: "未分类错误",
} as const;

export function RerankDiagnostics({
	stages,
}: {
	stages: OperationsEventDetail["stages"];
}) {
	return stages.map((stage) => {
		const diagnostic =
			stage.stage === "retrieve" || stage.stage === "table_retrieve"
				? stage.detail?.rerank
				: null;
		if (!diagnostic) return null;
		const fields = [
			["执行结果", RERANK_CATEGORY_LABELS[diagnostic.category]],
			["HTTP 状态", diagnostic.statusCode],
			["尝试次数", diagnostic.attempts],
			[
				"总预算",
				diagnostic.timeoutMs == null ? null : `${diagnostic.timeoutMs} ms`,
			],
			["实际耗时", `${diagnostic.durationMs} ms`],
			[
				"候选 / 返回",
				`${diagnostic.inputCount} / ${diagnostic.resultCount ?? "—"}`,
			],
			[
				"图像记录",
				`${diagnostic.figureCountBeforeRerank} → ${diagnostic.figureCountAfterRerank} → ${diagnostic.figureCountAfterDedup} → ${diagnostic.figureCountAfterTopK}`,
			],
		].filter((field) => field[1] != null);
		return (
			<section key={stage.id} className="border-t border-border/70 pt-4">
				<h3 className="text-ui font-semibold">
					重排诊断 · 阶段 {stage.sequence}
				</h3>
				<dl className="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2">
					{fields.map(([label, value]) => (
						<div key={label} className="contents">
							<dt className="text-meta text-muted-foreground">{label}</dt>
							<dd className="min-w-0 break-words font-mono text-[11px]">
								{value}
							</dd>
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
	return stages.map((stage) => {
		const diagnostic = stage.detail?.qdrant;
		if (!diagnostic) return null;
		const labels = { ...RERANK_CATEGORY_LABELS, cancelled: "已取消" };
		const fields = [
			["操作", diagnostic.operation],
			["错误类别", labels[diagnostic.category]],
			["HTTP 状态", diagnostic.statusCode],
			["连接错误码", diagnostic.transportCode],
			["可重试", diagnostic.retryable ? "是" : "否"],
			["尝试次数", diagnostic.attempts],
			["调用耗时", `${diagnostic.durationMs} ms`],
			[
				"客户端超时",
				diagnostic.timeoutMs == null ? null : `${diagnostic.timeoutMs} ms`,
			],
		].filter((field) => field[1] != null);
		return (
			<section key={stage.id} className="border-t border-border/70 pt-4">
				<h3 className="text-ui font-semibold">Qdrant 诊断</h3>
				<dl className="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2">
					{fields.map(([label, value]) => (
						<div key={label} className="contents">
							<dt className="text-meta text-muted-foreground">{label}</dt>
							<dd className="min-w-0 break-words font-mono text-[11px]">
								{value}
							</dd>
						</div>
					))}
				</dl>
			</section>
		);
	});
}

function CopyValue({ value }: { value: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			onClick={async () => {
				await navigator.clipboard.writeText(value);
				setCopied(true);
				window.setTimeout(() => setCopied(false), 1_200);
			}}
			className="group flex w-full min-w-0 items-center gap-1.5 text-left font-mono text-[11px] text-foreground/85 hover:text-foreground"
			title="复制"
		>
			<span className="truncate">{value}</span>
			{copied ? (
				<Check className="size-3 shrink-0 text-cite" />
			) : (
				<Copy className="size-3 shrink-0 text-muted-foreground" />
			)}
		</button>
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
	const { identity, can } = useSession();
	const [retrying, setRetrying] = useState(false);
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
				["文档版本", detail.document_version_id],
			].filter((item): item is [string, string] => Boolean(item[1]))
		: [];

	return (
		<Sheet open={selected != null} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="w-full gap-0 sm:max-w-xl"
				showCloseButton
			>
				<SheetHeader className="border-b border-border/70">
					<SheetTitle className="pr-8">
						{selected?.source === "ask" ? "请求链路" : "故障诊断"}
					</SheetTitle>
					<SheetDescription>
						{selected?.source === "ask"
							? "Ask · 阶段耗时与执行结果"
							: "Job · 阶段耗时与恢复动作"}
					</SheetDescription>
				</SheetHeader>
				<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
					{!detail && !error ? (
						<div className="flex items-center gap-2 py-8 text-ui text-muted-foreground">
							<LoaderCircle className="size-4 animate-spin" /> 正在关联诊断信息
						</div>
					) : error ? (
						<div
							className="space-y-3 py-8 text-ui text-destructive"
							role="alert"
						>
							<p>详情暂时不可用，记录可能已被清理或当前无权访问。</p>
							<button
								type="button"
								className="inline-flex items-center gap-2 text-xs"
								onClick={() => void query.refetch()}
							>
								<RotateCcw className="size-3.5" />
								重新加载
							</button>
						</div>
					) : detail ? (
						<div className="space-y-5">
							<RequestOutcome detail={detail} />
							{detail.message || detail.can_retry ? (
								<section>
									{detail.message ? (
										<pre className="mt-3 max-h-32 overflow-auto border-t border-destructive/20 pt-3 font-mono text-[10px] whitespace-pre-wrap break-all text-muted-foreground">
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
													toast.success("已创建新的删除清理任务");
													onRecovered?.();
												} catch (cause) {
													toast.error(
														cause instanceof Error
															? cause.message
															: "重试清理失败",
													);
												} finally {
													setRetrying(false);
												}
											}}
											className="mt-3 inline-flex h-8 items-center gap-1.5 border border-destructive/30 bg-background px-3 text-xs font-medium text-foreground hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
										>
											{retrying ? (
												<LoaderCircle className="size-3.5 animate-spin" />
											) : (
												<RotateCcw className="size-3.5" />
											)}
											重试清理
										</button>
									) : null}
								</section>
							) : null}

							<section>
								<div className="mb-2 flex items-baseline justify-between">
									<h3 className="text-ui font-semibold">阶段瀑布</h3>
									<span className="font-mono text-[11px] text-muted-foreground">
										{detail.latency_ms == null
											? `${detail.stages.length} stages`
											: formatDurationMs(detail.latency_ms)}
									</span>
								</div>
								<StageWaterfall stages={detail.stages} />
							</section>
							<JudgeDiagnostics stages={detail.stages} />
							<CitationDiagnostics stages={detail.stages} />
							<RerankDiagnostics stages={detail.stages} />
							<QdrantDiagnostics stages={detail.stages} />

							<section className="border-t border-border/70 pt-4">
								<h3 className="text-ui font-semibold">关联信息</h3>
								<dl className="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2">
									<div className="contents">
										<dt className="text-meta text-muted-foreground">
											发生时间
										</dt>
										<dd className="font-mono text-[11px]">
											{formatDateTime(detail.ended_at ?? detail.started_at)}
										</dd>
									</div>
									{identifiers.map(([label, value]) => (
										<div key={label} className="contents">
											<dt className="text-meta text-muted-foreground">
												{label}
											</dt>
											<dd className="min-w-0">
												<CopyValue value={value} />
											</dd>
										</div>
									))}
								</dl>
								{detail.library_id && detail.document_id ? (
									<a
										href="/app/libraries"
										className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-cite hover:underline"
									>
										打开知识库 <ExternalLink className="size-3" />
									</a>
								) : null}
							</section>
						</div>
					) : null}
				</div>
			</SheetContent>
		</Sheet>
	);
}
