"use client";

import {
	Check,
	Copy,
	ExternalLink,
	LoaderCircle,
	RotateCcw,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

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

export type OperationsErrorRef = {
	id: string;
	source: "ask" | "job";
};

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
	const [detail, setDetail] = useState<OperationsEventDetail | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [retrying, setRetrying] = useState(false);

	useEffect(() => {
		if (!selected) return;
		const controller = new AbortController();
		setDetail(null);
		setError(null);
		setRetrying(false);
		void fetch(
			`/api/workspace/operations/events/${selected.source}/${encodeURIComponent(selected.id)}`,
			{ cache: "no-store", signal: controller.signal },
		)
			.then(async (response) => {
				if (!response.ok) throw new Error(`event_http_${response.status}`);
				return (await response.json()) as OperationsEventDetail;
			})
			.then(setDetail)
			.catch((cause) => {
				if ((cause as Error).name !== "AbortError")
					setError("错误详情暂时不可用");
			});
		return () => controller.abort();
	}, [selected]);

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
					<SheetTitle className="pr-8">故障诊断</SheetTitle>
					<SheetDescription>
						从错误事件定位资源、失败阶段与恢复动作
					</SheetDescription>
				</SheetHeader>
				<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
					{!detail && !error ? (
						<div className="flex items-center gap-2 py-8 text-ui text-muted-foreground">
							<LoaderCircle className="size-4 animate-spin" /> 正在关联诊断信息
						</div>
					) : error ? (
						<p className="py-8 text-ui text-destructive">{error}</p>
					) : detail ? (
						<div className="space-y-5">
							<section className="border border-destructive/30 bg-destructive/5 px-3 py-3">
								<div className="flex items-start justify-between gap-3">
									<div>
										<p className="text-ui font-semibold">
											{detail.guidance.title}
										</p>
										<p className="mt-1 font-mono text-[11px] text-destructive">
											{detail.error_code ?? "unclassified_error"}
										</p>
									</div>
									<span className="font-mono text-[10px] uppercase text-muted-foreground">
										{detail.source} · {detail.status}
									</span>
								</div>
								<p className="mt-3 text-ui text-foreground/85">
									{detail.guidance.cause}
								</p>
								<p className="mt-2 text-ui text-muted-foreground">
									建议：{detail.guidance.recovery}
								</p>
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
