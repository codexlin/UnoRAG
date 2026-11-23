import { ChevronRight } from "lucide-react";
import type { ApiDocument } from "@/lib/api";
import { useInterfaceLanguage, useInterfaceText } from "@/lib/i18n/provider";
import {
	formatParserReportView,
	PARSE_DEGRADED_REINDEX_HINT,
	resolveDocumentStatusDisplay,
} from "@/lib/parser-report-view.mjs";
import { cn } from "@/lib/utils";

const STATUS_LABEL_EN: Record<string, string> = {
	就绪: "Ready",
	"已就绪（降级）": "Ready (fallback)",
	索引中: "Indexing",
	空库: "Empty",
	处理中: "Processing",
	降级可用: "Available (degraded)",
	已取消: "Cancelled",
	失败: "Failed",
	删除中: "Deleting",
	已删除: "Deleted",
	活跃: "Active",
	已替代: "Superseded",
	待处理: "Pending",
	已索引: "Indexed",
};

const PARSER_LABEL_EN: Record<string, string> = {
	"302 云解析": "302 Cloud Parser",
	"自建 MinerU": "Self-hosted MinerU",
	原生文本: "Plain text",
};

const TASK_STATUS_EN: Record<string, string> = {
	"等待 302 云解析": "Waiting for 302 Cloud Parser",
	排队中: "Queued",
	解析中: "Parsing",
	切片中: "Chunking",
	索引中: "Indexing",
	读取原文: "Reading source",
	处理中: "Processing",
	已完成: "Completed",
	失败: "Failed",
	已取消: "Cancelled",
	就绪: "Ready",
	降级可用: "Available (degraded)",
};

const QUALITY_HINT_EN: Record<string, string> = {
	"偏好：强制高质量解析": "Preference: Force high-quality parsing",
	"偏好：严格不出域（仅本地）": "Preference: Local only (no external egress)",
	"偏好：自动识别": "Preference: Auto detect",
	已使用增强解析: "Enhanced parsing used",
	"基础解析（部分页未完成）": "Basic parsing (some pages incomplete)",
	"基础解析（PyMuPDF）": "Basic parsing (PyMuPDF)",
};

const DEGRADE_REASON_EN: Record<string, string> = {
	"增强解析不可用，已用基础解析":
		"Enhanced parser unavailable; used basic parsing",
	"未启用增强解析，使用基础解析":
		"Enhanced parser disabled; used basic parsing",
};

function localizeReportSummary(line: string, locale: "zh-CN" | "en"): string {
	if (locale === "zh-CN") return line;
	if (line === "已用基础解析（PyMuPDF）· MinerU 暂不可用（短窗熔断）") {
		return "Basic parser (PyMuPDF) used · MinerU temporarily unavailable (circuit open)";
	}
	if (line === "已用基础解析（PyMuPDF）· MinerU 暂不可用") {
		return "Basic parser (PyMuPDF) used · MinerU temporarily unavailable";
	}
	const partialMatch = line.match(/^部分页未解析(?:（失败页 (.+)）)?$/);
	if (partialMatch) {
		return partialMatch[1]
			? `Some pages were not parsed (failed pages: ${partialMatch[1]})`
			: "Some pages were not parsed";
	}
	const ocrMatch = line.match(/^建议 OCR 页：(.+)$/);
	if (ocrMatch) {
		return `OCR recommended for pages: ${ocrMatch[1]}`;
	}
	return line;
}

export function DocumentStatusBadge({
	status,
	parserReport,
}: {
	status: string;
	parserReport?: ApiDocument["parser_report"];
}) {
	const { locale } = useInterfaceLanguage();
	const display = resolveDocumentStatusDisplay(status, parserReport);
	const tone = display.tone;
	const label =
		locale === "zh-CN"
			? display.label
			: (STATUS_LABEL_EN[display.label] ?? display.label);
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
			{label}
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
	const { locale } = useInterfaceLanguage();
	const t = useInterfaceText();
	const reportView = formatParserReportView(report);
	const status = parseStatus ?? null;
	const rawParser = status?.parser_label || report?.parser;
	const parser =
		rawParser && locale === "en"
			? (PARSER_LABEL_EN[rawParser] ?? rawParser)
			: rawParser;
	const taskStatus =
		status?.task_status && locale === "en"
			? (TASK_STATUS_EN[status.task_status] ?? status.task_status)
			: status?.task_status;
	const qualityHint =
		status?.parse_quality_hint && locale === "en"
			? (QUALITY_HINT_EN[status.parse_quality_hint] ??
				status.parse_quality_hint)
			: status?.parse_quality_hint;
	const degradeReason =
		status?.degrade_reason && locale === "en"
			? (DEGRADE_REASON_EN[status.degrade_reason] ?? status.degrade_reason)
			: status?.degrade_reason;
	return (
		<div className="space-y-3 [overflow-wrap:anywhere]">
			<div className="flex flex-wrap items-center gap-2">
				<p className="text-xs text-muted-foreground">
					{t(reportView.title, "Latest parser report")}
				</p>
				{reportView.degraded ? (
					<span className="text-xs text-survey">
						{t("降级处理", "Parsing fallback")}
					</span>
				) : null}
			</div>
			{parser ? (
				<p className="text-sm leading-relaxed">
					{t("实际解析器：", "Parser: ")}
					{parser}
				</p>
			) : null}
			{status?.external_processing != null ? (
				<p className="text-sm text-muted-foreground">
					{status.external_processing === true
						? t("已出域处理", "Processed externally")
						: t("未出域", "Processed locally")}
				</p>
			) : null}
			{taskStatus ? (
				<p className="text-sm text-muted-foreground">
					{t("任务状态：", "Job status: ")}
					{taskStatus}
				</p>
			) : null}
			{qualityHint ? (
				<p className="text-sm text-muted-foreground">{qualityHint}</p>
			) : null}
			{degradeReason ? (
				<p className="text-sm text-survey">
					{t("降级原因：", "Fallback reason: ")}
					{degradeReason}
				</p>
			) : null}
			{status?.provider_task_id ? (
				<p className="font-mono text-xs leading-relaxed text-muted-foreground">
					{t("任务 ID：", "Job ID: ")}
					{status.provider_task_id}
				</p>
			) : null}
			{reportView.summaries.map((line) => {
				const localized = localizeReportSummary(line, locale);
				return (
					<p
						key={line}
						className={cn(
							"text-sm leading-relaxed",
							line.startsWith("建议 OCR")
								? "text-muted-foreground"
								: "text-survey",
						)}
					>
						{localized}
					</p>
				);
			})}
			{reportView.degraded ? (
				<p className="text-sm text-muted-foreground">
					{t(
						PARSE_DEGRADED_REINDEX_HINT,
						"Re-index once MinerU is available for better parsing quality.",
					)}
				</p>
			) : null}
			{reportView.techDetails.length > 0 ? (
				<details className="group">
					<summary className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
						<ChevronRight
							className="size-4 shrink-0 group-open:rotate-90"
							aria-hidden
						/>
						{t("技术详情", "Technical details")}
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
					{report
						? t("报告无额外提示", "No additional parser details")
						: t("暂无解析报告", "No parser report")}
				</p>
			) : null}
		</div>
	);
}
