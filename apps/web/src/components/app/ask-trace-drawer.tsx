"use client";

import { Check, ChevronDown, Copy } from "lucide-react";
import { useState } from "react";

import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import type { ApiAskStage, ApiRetrievalDebug } from "@/lib/api";
import { formatDurationMs } from "@/lib/format";
import { cn } from "@/lib/utils";

const STAGE_LABELS: Record<string, string> = {
	route: "路由",
	retrieve: "检索",
	gate: "门控",
	table_load: "表加载",
	table_execute: "表执行",
	generate: "生成",
	persist: "持久化",
};

function stageLabel(name: string): string {
	return STAGE_LABELS[name] || name;
}

function formatDebugValue(value: unknown): string {
	if (value == null) return "—";
	if (typeof value === "boolean") return value ? "是" : "否";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return "—";
		return Number.isInteger(value) ? String(value) : value.toFixed(3);
	}
	if (typeof value === "string") return value || "—";
	if (Array.isArray(value)) {
		if (value.length === 0) return "—";
		return value.map((item) => formatDebugValue(item)).join(", ");
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function summaryRows(debug: ApiRetrievalDebug): { label: string; value: string }[] {
	const total =
		typeof debug.total_duration_ms === "number"
			? formatDurationMs(debug.total_duration_ms)
			: "—";
	return [
		{ label: "path", value: formatDebugValue(debug.path) },
		{ label: "route", value: formatDebugValue(debug.route) },
		{ label: "precise_gate", value: formatDebugValue(debug.precise_gate) },
		{
			label: "upgrade",
			value:
				debug.upgrade == null || debug.upgrade === ""
					? "—"
					: formatDebugValue(debug.upgrade),
		},
		{ label: "总耗时", value: total },
	];
}

function StageRow({ stage }: { stage: ApiAskStage }) {
	const [open, setOpen] = useState(false);
	const detail = stage.detail ?? {};
	const detailEntries = Object.entries(detail);
	const hasDetail = detailEntries.length > 0;

	return (
		<li className="border-b border-border/50 last:border-b-0">
			<button
				type="button"
				disabled={!hasDetail}
				onClick={() => hasDetail && setOpen((v) => !v)}
				className={cn(
					"flex w-full items-center gap-2 px-0 py-2.5 text-left",
					hasDetail
						? "cursor-pointer hover:bg-muted/40"
						: "cursor-default opacity-90",
				)}
			>
				<span
					className={cn(
						"mt-0.5 size-1.5 shrink-0 rounded-full",
						stage.ok ? "bg-cite" : "bg-destructive",
					)}
					aria-hidden
				/>
				<span className="min-w-0 flex-1">
					<span className="text-ui font-medium text-foreground">
						{stageLabel(stage.stage)}
					</span>
					<span className="ml-2 font-mono text-[11px] text-muted-foreground">
						{stage.stage}
					</span>
				</span>
				<span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
					{formatDurationMs(stage.duration_ms)}
				</span>
				{!stage.ok ? (
					<span className="shrink-0 font-mono text-[10px] text-destructive">
						失败
					</span>
				) : null}
				{hasDetail ? (
					<ChevronDown
						className={cn(
							"size-3.5 shrink-0 text-muted-foreground transition-transform",
							open && "rotate-180",
						)}
						aria-hidden
					/>
				) : (
					<span className="size-3.5 shrink-0" aria-hidden />
				)}
			</button>
			{open && hasDetail ? (
				<dl className="mb-2 ml-3.5 space-y-1.5 border-l border-border/60 pl-3">
					{detailEntries.map(([key, value]) => (
						<div key={key} className="flex flex-wrap gap-x-2 gap-y-0.5">
							<dt className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
								{key}
							</dt>
							<dd className="break-all font-mono text-[11px] text-foreground/85">
								{formatDebugValue(value)}
							</dd>
						</div>
					))}
				</dl>
			) : null}
		</li>
	);
}

function CopyTraceId({ traceId }: { traceId: string }) {
	const [copied, setCopied] = useState(false);

	async function onCopy() {
		try {
			await navigator.clipboard.writeText(traceId);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1400);
		} catch {
			setCopied(false);
		}
	}

	return (
		<button
			type="button"
			onClick={() => void onCopy()}
			className="group flex w-full items-center gap-2 rounded-md border border-border/70 bg-background/80 px-2.5 py-2 text-left transition-colors hover:border-cite/35 hover:bg-cite/5"
			title="复制 trace_id"
		>
			<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/90">
				{traceId}
			</span>
			{copied ? (
				<Check className="size-3.5 shrink-0 text-cite" aria-hidden />
			) : (
				<Copy className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden />
			)}
			<span className="sr-only">{copied ? "已复制" : "复制 trace_id"}</span>
		</button>
	);
}

export function hasAskTrace(debug?: ApiRetrievalDebug | null): boolean {
	if (!debug || typeof debug !== "object") return false;
	const stages = debug.stages;
	if (Array.isArray(stages) && stages.length > 0) return true;
	return typeof debug.trace_id === "string" && debug.trace_id.length > 0;
}

export function AskTraceDrawer({
	open,
	onOpenChange,
	debug,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	debug: ApiRetrievalDebug | null;
}) {
	const stages = Array.isArray(debug?.stages) ? debug.stages : [];
	const rows = debug ? summaryRows(debug) : [];
	const traceId =
		typeof debug?.trace_id === "string" && debug.trace_id ? debug.trace_id : null;
	const rawJson = debug
		? JSON.stringify(debug, null, 2)
		: "";

	return (
		<Sheet open={open && debug != null} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="w-full gap-0 sm:max-w-md"
				showCloseButton
			>
				{debug ? (
					<>
						<SheetHeader className="border-b border-border/70">
							<SheetTitle className="pr-8">请求链路</SheetTitle>
							<SheetDescription>
								本轮 Ask 的 stages 与检索调试信息
							</SheetDescription>
						</SheetHeader>

						<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">
							<section className="space-y-2">
								<p className="text-meta font-mono tracking-[0.14em] text-muted-foreground uppercase">
									摘要
								</p>
								<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
									{rows.map((row) => (
										<div key={row.label} className="contents">
											<dt className="font-mono text-[11px] text-muted-foreground">
												{row.label}
											</dt>
											<dd className="truncate font-mono text-[11px] text-foreground/90">
												{row.value}
											</dd>
										</div>
									))}
								</dl>
								{typeof debug.upgrade_reason === "string" &&
								debug.upgrade_reason ? (
									<p className="font-mono text-[11px] text-muted-foreground">
										upgrade_reason · {debug.upgrade_reason}
									</p>
								) : null}
								{typeof debug.downgrade_reason === "string" &&
								debug.downgrade_reason ? (
									<p className="font-mono text-[11px] text-survey">
										downgrade_reason · {debug.downgrade_reason}
									</p>
								) : null}
							</section>

							<section className="space-y-2">
								<p className="text-meta font-mono tracking-[0.14em] text-muted-foreground uppercase">
									trace_id
								</p>
								{traceId ? (
									<CopyTraceId traceId={traceId} />
								) : (
									<p className="font-mono text-[11px] text-muted-foreground">
										—
									</p>
								)}
							</section>

							<section className="space-y-1">
								<div className="flex items-baseline justify-between gap-2">
									<p className="text-meta font-mono tracking-[0.14em] text-muted-foreground uppercase">
										Stages
									</p>
									<span className="font-mono text-[11px] text-muted-foreground">
										{stages.length} 步
									</span>
								</div>
								{stages.length === 0 ? (
									<p className="text-ui text-muted-foreground">暂无 stage 记录</p>
								) : (
									<ul className="divide-y-0">
										{stages.map((stage, index) => (
											<StageRow
												key={`${stage.stage}-${index}`}
												stage={stage}
											/>
										))}
									</ul>
								)}
							</section>

							<details className="group rounded-md border border-border/70">
								<summary className="cursor-pointer list-none px-3 py-2 font-mono text-[11px] tracking-wide text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground [&::-webkit-details-marker]:hidden">
									<span className="inline-flex items-center gap-1.5">
										<ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
										原始 JSON
									</span>
								</summary>
								<pre className="max-h-64 overflow-auto border-t border-border/60 px-3 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground whitespace-pre-wrap break-all">
									{rawJson}
								</pre>
							</details>
						</div>
					</>
				) : null}
			</SheetContent>
		</Sheet>
	);
}
