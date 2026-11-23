"use client";

import { AlertCircle, CheckCircle2, LoaderCircle, XCircle } from "lucide-react";

import { formatDurationMs } from "@/lib/format";
import { interfaceText, type Locale } from "@/lib/i18n/locale";
import { useInterfaceLanguage, useInterfaceText } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

export type WaterfallStage = {
	id?: string;
	sequence?: number;
	attempt?: number | null;
	stage: string;
	outcome?: string;
	ok?: boolean;
	error_code?: string | null;
	duration_ms?: number | null;
	started_at?: string | null;
	ended_at?: string | null;
};

const STAGE_LABELS: Record<string, readonly [zh: string, en: string]> = {
	request: ["请求", "Request"],
	accepted: ["排队", "Queued"],
	downloading: ["读取文件", "Read file"],
	parsing: ["文档解析", "Parse document"],
	chunking: ["内容切分", "Chunk content"],
	embedding: ["向量化", "Embed"],
	indexing: ["写入索引", "Write index"],
	validating: ["索引校验", "Validate index"],
	awaiting_activation: ["等待激活", "Awaiting activation"],
	activating: ["版本激活", "Activate version"],
	cleanup: ["清理旧版本", "Clean up old version"],
	done: ["完成", "Done"],
	route: ["问题路由", "Route query"],
	plan: ["检索规划", "Plan retrieval"],
	clarify: ["问题澄清", "Clarify query"],
	rewrite: ["问题改写", "Rewrite query"],
	retrieve: ["知识检索", "Retrieve"],
	judge: ["证据判断", "Judge evidence"],
	retry: ["检索重试", "Retry retrieval"],
	prepare_generate: ["生成准备", "Prepare generation"],
	refuse: ["拒答", "Refuse"],
	table_plan: ["表格规划", "Plan table"],
	table_retrieve: ["表格检索", "Retrieve table"],
	table_execute: ["表格执行", "Execute table"],
	generate: ["答案生成", "Generate answer"],
	persist: ["会话持久化", "Persist session"],
};

export function stageDisplayName(
	stage: string,
	locale: Locale = "zh-CN",
): string {
	const labels = STAGE_LABELS[stage];
	if (!labels) return stage;
	return interfaceText(locale)(labels[0], labels[1]);
}

function stageDuration(stage: WaterfallStage): number {
	if (
		typeof stage.duration_ms === "number" &&
		Number.isFinite(stage.duration_ms)
	) {
		return Math.max(0, stage.duration_ms);
	}
	if (stage.started_at && stage.ended_at) {
		const started = Date.parse(stage.started_at);
		const ended = Date.parse(stage.ended_at);
		if (Number.isFinite(started) && Number.isFinite(ended)) {
			return Math.max(0, ended - started);
		}
	}
	return 0;
}

function normalizedOutcome(stage: WaterfallStage) {
	if (stage.outcome) return stage.outcome;
	return stage.ok === false ? "failed" : "completed";
}

export function StageWaterfall({
	stages,
	className,
	compact = false,
}: {
	stages: WaterfallStage[];
	className?: string;
	compact?: boolean;
}) {
	const { locale } = useInterfaceLanguage();
	const t = useInterfaceText();
	const rows = stages.map((stage) => ({
		...stage,
		duration: stageDuration(stage),
		outcome: normalizedOutcome(stage),
	}));
	const total = Math.max(
		1,
		rows.reduce((sum, stage) => sum + stage.duration, 0),
	);
	let elapsed = 0;

	if (rows.length === 0) {
		return (
			<p className="text-ui text-muted-foreground">
				{t("暂无阶段记录", "No stage records")}
			</p>
		);
	}

	return (
		<div className={cn("space-y-1", className)}>
			{rows.map((stage, index) => {
				const offset = elapsed;
				elapsed += stage.duration;
				const left = (offset / total) * 100;
				const width = Math.max(1.25, (stage.duration / total) * 100);
				const failed = stage.outcome === "failed";
				const cancelled = stage.outcome === "cancelled";
				const running = stage.outcome === "running";
				const Icon = failed
					? AlertCircle
					: cancelled
						? XCircle
						: running
							? LoaderCircle
							: CheckCircle2;
				return (
					<div
						key={stage.id ?? `${stage.stage}:${index}`}
						className={cn(
							"grid items-center gap-2 sm:gap-3",
							compact
								? "grid-cols-[minmax(4.75rem,6.5rem)_minmax(3rem,1fr)_3.75rem] py-1"
								: "grid-cols-[minmax(5.5rem,7rem)_minmax(3.5rem,1fr)_4rem] py-1.5 sm:grid-cols-[8.5rem_minmax(6rem,1fr)_5rem]",
						)}
					>
						<div className="flex min-w-0 items-center gap-2">
							<Icon
								className={cn(
									"size-3.5 shrink-0",
									running && "animate-spin text-survey",
									failed && "text-destructive",
									cancelled && "text-muted-foreground",
									!running && !failed && !cancelled && "text-cite",
								)}
								aria-hidden
							/>
							<span className="truncate text-xs" title={stage.stage}>
								{stageDisplayName(stage.stage, locale)}
							</span>
							{stage.attempt != null && stage.attempt > 1 ? (
								<span className="font-mono text-[9px] text-muted-foreground">
									#{stage.attempt}
								</span>
							) : null}
						</div>
						<div className="relative h-5 overflow-hidden border border-border/60 bg-muted/45">
							<div
								className={cn(
									"absolute inset-y-0.5 min-w-0.5 transition-[width]",
									failed && "bg-destructive/75",
									cancelled && "bg-muted-foreground/55",
									running && "animate-pulse bg-survey/75",
									!failed && !cancelled && !running && "bg-cite/70",
								)}
								style={{
									left: `${left}%`,
									width: `${Math.min(width, 100 - left)}%`,
								}}
							/>
						</div>
						<span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
							{running
								? t("进行中", "Running")
								: formatDurationMs(stage.duration)}
						</span>
						{stage.error_code ? (
							<p className="col-span-full pl-5 truncate font-mono text-[10px] text-destructive">
								{stage.error_code}
							</p>
						) : null}
					</div>
				);
			})}
		</div>
	);
}
