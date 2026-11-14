import { ChevronRight } from "lucide-react";

import type { ApiDocument } from "@/lib/api";
import {
	formatParserReportView,
	PARSE_DEGRADED_REINDEX_HINT,
	resolveDocumentStatusDisplay,
} from "@/lib/parser-report-view.mjs";
import { cn } from "@/lib/utils";

export function DocumentStatusBadge({
	status,
	parserReport,
}: {
	status: string;
	parserReport?: ApiDocument["parser_report"];
}) {
	const display = resolveDocumentStatusDisplay(status, parserReport);
	const tone = display.tone;
	return (
		<span
			className={cn(
				"max-w-full rounded-sm border px-2 py-0.5 text-xs [overflow-wrap:anywhere]",
				tone === "ready" && "border-cite/30 bg-cite/10 text-cite",
				tone === "processing" &&
					"border-survey/35 bg-warning text-warning-foreground",
				tone === "failed" &&
					"border-destructive/30 bg-destructive/10 text-destructive",
				tone === "degraded" &&
					"border-survey/35 bg-warning text-warning-foreground",
				tone === "cancelled" && "border-border bg-muted text-muted-foreground",
				tone === "indexing" &&
					"border-survey/35 bg-warning text-warning-foreground",
				tone === "empty" && "border-border bg-muted text-muted-foreground",
				tone === "deleting" &&
					"border-destructive/30 bg-destructive/10 text-destructive",
				![
					"ready",
					"processing",
					"failed",
					"degraded",
					"cancelled",
					"indexing",
					"empty",
					"deleting",
				].includes(tone) && "border-border bg-muted text-muted-foreground",
			)}
		>
			{display.label}
		</span>
	);
}

export function ParserReportCard({
	report,
	parseStatus,
}: {
	report: ApiDocument["parser_report"];
	parseStatus?: ApiDocument["parse_status"];
}) {
	const reportView = formatParserReportView(report);
	const status = parseStatus ?? null;
	const parser = status?.parser_label || report?.parser;
	return (
		<div className="space-y-3 [overflow-wrap:anywhere]">
			<div className="flex flex-wrap items-center gap-2">
				<p className="text-xs text-muted-foreground">{reportView.title}</p>
				{reportView.degraded ? (
					<span className="text-xs text-survey">降级处理</span>
				) : null}
			</div>
			{parser ? (
				<p className="text-sm leading-relaxed">实际解析器：{parser}</p>
			) : null}
			{status?.external_processing != null ? (
				<p className="text-sm text-muted-foreground">
					{status.external_processing === true ? "已出域处理" : "未出域"}
				</p>
			) : null}
			{status?.task_status ? (
				<p className="text-sm text-muted-foreground">
					任务状态：{status.task_status}
				</p>
			) : null}
			{status?.parse_quality_hint ? (
				<p className="text-sm text-muted-foreground">
					{status.parse_quality_hint}
				</p>
			) : null}
			{status?.degrade_reason ? (
				<p className="text-sm text-survey">降级原因：{status.degrade_reason}</p>
			) : null}
			{status?.provider_task_id ? (
				<p className="font-mono text-xs leading-relaxed text-muted-foreground">
					任务 ID：{status.provider_task_id}
				</p>
			) : null}
			{reportView.summaries.map((line) => (
				<p
					key={line}
					className={cn(
						"text-sm leading-relaxed",
						line.startsWith("建议 OCR")
							? "text-muted-foreground"
							: "text-survey",
					)}
				>
					{line}
				</p>
			))}
			{reportView.degraded ? (
				<p className="text-sm text-muted-foreground">
					{PARSE_DEGRADED_REINDEX_HINT}
				</p>
			) : null}
			{reportView.techDetails.length > 0 ? (
				<details className="group">
					<summary className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
						<ChevronRight
							className="size-4 shrink-0 group-open:rotate-90"
							aria-hidden
						/>
						技术详情
					</summary>
					<ul className="space-y-2 pb-2 text-muted-foreground">
						{reportView.techDetails.map((detail) => (
							<li key={detail} className="font-mono text-xs leading-relaxed">
								{detail}
							</li>
						))}
					</ul>
				</details>
			) : null}
			{!report || (reportView.empty && !parser) ? (
				<p className="text-sm text-muted-foreground">
					{report ? "报告无额外提示" : "暂无解析报告"}
				</p>
			) : null}
		</div>
	);
}
