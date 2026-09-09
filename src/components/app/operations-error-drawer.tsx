"use client";

import { Check, Copy, ExternalLink, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import {
	StageWaterfall,
	type WaterfallStage,
} from "@/components/app/stage-waterfall";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { formatDateTime, formatDurationMs } from "@/lib/format";

export type OperationsErrorRef = {
	id: string;
	source: "ask" | "job";
};

type ErrorDetail = {
	source: "ask" | "job";
	id: string;
	resource_id?: string;
	status: string;
	error_code: string | null;
	guidance: { title: string; cause: string; recovery: string };
	request_id: string | null;
	otel_trace_id: string | null;
	workflow_id: string | null;
	library_id: string | null;
	document_id: string | null;
	document_version_id: string | null;
	query_type: string | null;
	retrieval_mode: string | null;
	started_at: string;
	ended_at: string | null;
	latency_ms: number | null;
	message: string | null;
	stages: WaterfallStage[];
};

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
			className="group flex min-w-0 items-center gap-1.5 text-left font-mono text-[11px] text-foreground/85 hover:text-foreground"
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
}: {
	selected: OperationsErrorRef | null;
	onOpenChange: (open: boolean) => void;
}) {
	const [detail, setDetail] = useState<ErrorDetail | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!selected) return;
		const controller = new AbortController();
		setDetail(null);
		setError(null);
		void fetch(
			`/api/workspace/operations/events/${selected.source}/${encodeURIComponent(selected.id)}`,
			{ cache: "no-store", signal: controller.signal },
		)
			.then(async (response) => {
				if (!response.ok) throw new Error(`event_http_${response.status}`);
				return (await response.json()) as ErrorDetail;
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
