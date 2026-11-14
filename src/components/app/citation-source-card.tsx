"use client";

import { ChevronDown, FileText, Hash, Layers3 } from "lucide-react";
import type { ReactNode } from "react";

import { formatScore } from "@/lib/format";
import type { UiCitation } from "@/lib/ui-types";
import { cn } from "@/lib/utils";

function CitationBody({
	citation,
	active,
	compact,
	expanded,
	showDiagnostics,
}: {
	citation: UiCitation;
	active?: boolean;
	compact?: boolean;
	expanded?: boolean;
	showDiagnostics?: boolean;
}) {
	const preview = (citation.snippet || citation.text || "")
		.replace(/\s+/g, " ")
		.trim();
	const fullText = citation.text || citation.snippet || "";

	return (
		<div className="flex min-w-0 items-start gap-3">
			<span
				className={cn(
					"mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-sm font-mono text-xs font-medium",
					active
						? "bg-evidence text-evidence-foreground"
						: "bg-evidence/10 text-evidence",
				)}
			>
				{citation.index}
			</span>
			<div className="min-w-0 flex-1 space-y-2">
				<div className="flex flex-wrap items-center gap-1.5">
					<p className="min-w-0 text-sm font-medium leading-6 text-foreground [overflow-wrap:anywhere]">
						{citation.title}
					</p>
				</div>
				<div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
					{citation.sectionPath ? (
						<span className="inline-flex min-w-0 items-start gap-1">
							<Layers3 className="mt-0.5 size-3 shrink-0" aria-hidden />
							{citation.sectionPath}
						</span>
					) : null}
					{citation.page ? (
						<span className="inline-flex items-center gap-1">
							<Hash className="size-3" aria-hidden />页 {citation.page}
						</span>
					) : null}
					{citation.filename ? (
						<span className="inline-flex min-w-0 items-center gap-1 truncate">
							<FileText className="size-3 shrink-0" />
							<span className="truncate">{citation.filename}</span>
						</span>
					) : null}
				</div>
				{citation.preamble && expanded ? (
					<p className="border-l-2 border-evidence/40 pl-3 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
						定位 {citation.preamble}
					</p>
				) : null}
				{expanded ? (
					<div className="space-y-4 pt-3">
						<dl className="space-y-1 text-xs text-muted-foreground">
							<dt>回答所用版本</dt>
							<dd className="font-mono text-foreground [overflow-wrap:anywhere]">
								{citation.source?.document_version_id || "未记录"}
							</dd>
							{citation.source?.row_start != null ? (
								<>
									<dt className="pt-2">表格行组</dt>
									<dd>
										{citation.source.row_start}
										{citation.source.row_end != null
											? ` 至 ${citation.source.row_end}`
											: ""}
									</dd>
								</>
							) : null}
						</dl>
						<section className="space-y-2 border-t pt-4">
							<h3 className="text-sm font-medium">来源片段</h3>
							<p className="text-answer whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
								{fullText || "未记录来源片段"}
							</p>
						</section>
					</div>
				) : !compact ? (
					<p className="line-clamp-2 text-sm text-muted-foreground [overflow-wrap:anywhere]">
						{preview || "（无预览）"}
					</p>
				) : null}
				{showDiagnostics ? (
					<details className="group border-t pt-3">
						<summary className="flex min-h-11 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
							<ChevronDown
								className="size-3.5 transition-transform group-open:rotate-180"
								aria-hidden
							/>
							检索诊断
						</summary>
						<div className="mb-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
							{citation.usedRerank ? <span>本次使用重排</span> : null}
							{citation.usedHybrid ? <span>本次使用混合检索</span> : null}
						</div>
						<dl className="space-y-2 text-xs">
							{[
								["排序分数", citation.score],
								["Dense", citation.denseScore],
								["BM25", citation.bm25Score],
								["RRF", citation.rrfScore],
							].map(([label, value]) =>
								typeof value === "number" && Number.isFinite(value) ? (
									<div className="flex justify-between gap-3" key={label}>
										<dt className="text-muted-foreground">{label}</dt>
										<dd className="font-mono tabular-nums">
											{formatScore(value)}
										</dd>
									</div>
								) : null,
							)}
						</dl>
					</details>
				) : null}
			</div>
		</div>
	);
}

export function CitationSourceCard({
	citation,
	active,
	onSelect,
	compact = false,
	expanded = false,
	showDiagnostics = false,
}: {
	citation: UiCitation;
	active?: boolean;
	onSelect?: (citation: UiCitation) => void;
	compact?: boolean;
	/** Show full text + preamble (for evidence drawer). */
	expanded?: boolean;
	/** Reveal retrieval scores behind a secondary disclosure. */
	showDiagnostics?: boolean;
}) {
	const className = cn(
		"w-full min-w-0 text-left",
		expanded
			? ""
			: "min-h-11 rounded-lg border px-3 py-3 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
		!expanded &&
			(active
				? "border-evidence/45 bg-muted"
				: "border-border bg-background hover:bg-muted/60"),
	);

	const body: ReactNode = (
		<CitationBody
			citation={citation}
			active={active}
			compact={compact}
			expanded={expanded}
			showDiagnostics={showDiagnostics}
		/>
	);

	if (!onSelect) {
		return (
			<div className={className} data-active={active || undefined}>
				{body}
			</div>
		);
	}

	return (
		<button
			type="button"
			aria-label={`查看引用 ${citation.index}：${citation.title}`}
			data-citation-id={citation.id}
			aria-pressed={Boolean(active)}
			onClick={() => onSelect(citation)}
			className={className}
		>
			{body}
		</button>
	);
}
