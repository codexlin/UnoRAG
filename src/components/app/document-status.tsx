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
				"text-meta rounded-md border px-2 py-0.5 font-mono uppercase",
				tone === "ready" && "border-cite/30 bg-cite/10 text-cite",
				tone === "processing" &&
					"border-survey/35 bg-accent text-accent-foreground",
				tone === "failed" &&
					"border-destructive/30 bg-destructive/10 text-destructive",
				tone === "degraded" &&
					"border-survey/35 bg-accent text-accent-foreground",
				tone === "cancelled" && "border-border bg-muted text-muted-foreground",
				tone === "indexing" &&
					"border-survey/35 bg-accent text-accent-foreground",
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
	report: NonNullable<ApiDocument["parser_report"]>;
	parseStatus?: ApiDocument["parse_status"];
}) {
	const reportView = formatParserReportView(report);
	const status = parseStatus ?? null;
	return (
		<div
			className={cn(
				"rounded-md border px-3 py-2",
				reportView.degraded
					? "border-survey/40 bg-accent/40"
					: "border-border/80 bg-muted/30",
			)}
		>
			<div className="flex flex-wrap items-center gap-2">
				<p className="text-meta font-mono uppercase tracking-wide text-muted-foreground">
					{reportView.title}
				</p>
				{reportView.degraded ? (
					<span className="text-meta rounded-md border border-survey/35 bg-accent px-1.5 py-0.5 font-mono text-accent-foreground">
						降级处理
					</span>
				) : null}
			</div>
			{status?.parser_label ? (
				<p className="text-ui mt-1">
					实际解析器：{status.parser_label}
					{status.external_processing === true
						? " · 已出域处理"
						: status.external_processing === false
							? " · 未出域"
							: ""}
				</p>
			) : null}
			{status?.task_status ? (
				<p className="text-ui mt-1 text-muted-foreground">
					任务状态：{status.task_status}
				</p>
			) : null}
			{status?.parse_quality_hint ? (
				<p className="text-ui mt-1 text-muted-foreground">
					{status.parse_quality_hint}
				</p>
			) : null}
			{status?.degrade_reason ? (
				<p className="text-ui mt-1 text-survey">
					降级原因：{status.degrade_reason}
				</p>
			) : null}
			{status?.provider_task_id ? (
				<p className="text-meta mt-1 font-mono text-muted-foreground">
					任务 ID：{status.provider_task_id}
				</p>
			) : null}
			{reportView.summaries.map((line) => (
				<p
					key={line}
					className={cn(
						"text-ui mt-1",
						line.startsWith("建议 OCR")
							? "text-muted-foreground"
							: "text-survey",
					)}
				>
					{line}
				</p>
			))}
			{reportView.degraded ? (
				<p className="text-ui mt-1.5 text-muted-foreground">
					{PARSE_DEGRADED_REINDEX_HINT}
				</p>
			) : null}
			{reportView.techDetails.length > 0 ? (
				<details className="group mt-2 rounded-md border border-border/60 bg-background/40">
					<summary className="cursor-pointer list-none px-2 py-1.5 font-mono text-meta text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground [&::-webkit-details-marker]:hidden">
						技术详情
					</summary>
					<ul className="text-ui space-y-1 border-t border-border/50 px-2 py-1.5 text-muted-foreground">
						{reportView.techDetails.map((detail) => (
							<li
								key={detail}
								className="break-all font-mono text-[11px] leading-relaxed"
							>
								{detail}
							</li>
						))}
					</ul>
				</details>
			) : null}
			{reportView.empty && !status?.parser_label ? (
				<p className="text-ui mt-1 text-muted-foreground">
					解析完成，无额外提示
				</p>
			) : null}
		</div>
	);
}
