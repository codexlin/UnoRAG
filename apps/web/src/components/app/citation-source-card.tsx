"use client";

import { FileText, Hash, Layers3 } from "lucide-react";
import type { ReactNode } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { formatScore } from "@/lib/format";
import type { UiCitation } from "@/lib/ui-types";
import { cn } from "@/lib/utils";

function ScoreBar({
	label,
	value,
	tone = "cite",
	/** Multiply before mapping to bar width (e.g. raw RRF ≈ 0.03). */
	barScale = 1,
}: {
	label: string;
	value: number | null | undefined;
	tone?: "cite" | "primary" | "survey";
	barScale?: number;
}) {
	if (value == null || Number.isNaN(value)) return null;
	const scaled = value * barScale;
	const pct =
		scaled > 1
			? Math.max(0, Math.min(100, (scaled / (scaled + 5)) * 100))
			: Math.max(0, Math.min(100, scaled * 100));
	return (
		<div className="min-w-0 flex-1 space-y-1">
			<div className="text-meta flex items-center justify-between gap-2 font-mono text-muted-foreground">
				<span>{label}</span>
				<span className="tabular-nums text-foreground/85">
					{formatScore(value)}
				</span>
			</div>
			{/* Track needs stronger contrast than bg-muted on light surfaces */}
			<div className="h-2 overflow-hidden rounded-full border border-border/80 bg-foreground/[0.08] dark:border-border/50 dark:bg-foreground/15">
				<div
					className={cn(
						"h-full rounded-full transition-[width] duration-300",
						tone === "cite" && "bg-cite",
						tone === "primary" && "bg-primary",
						tone === "survey" && "bg-survey",
					)}
					style={{ width: `${pct}%` }}
				/>
			</div>
		</div>
	);
}

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
		<div className="flex items-start gap-2.5">
			<span
				className={cn(
					"text-meta mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-sm font-mono font-semibold",
					active
						? "bg-cite text-cite-foreground"
						: "bg-primary/10 text-primary",
				)}
			>
				{citation.index}
			</span>
			<div className="min-w-0 flex-1 space-y-1.5">
				<div className="flex flex-wrap items-center gap-1.5">
					<p className="truncate text-[0.9375rem] font-medium leading-snug text-foreground">
						{citation.title}
					</p>
					{citation.usedRerank ? (
						<span className="text-meta rounded-sm bg-survey/15 px-1.5 py-0.5 font-mono text-accent-foreground">
							rerank
						</span>
					) : null}
					{citation.usedHybrid ? (
						<span className="text-meta rounded-sm bg-primary/10 px-1.5 py-0.5 font-mono text-primary">
							hybrid
						</span>
					) : null}
				</div>
				<div className="text-meta flex flex-wrap gap-x-2 gap-y-1 font-mono text-muted-foreground">
					{citation.sectionPath ? (
						<span className="inline-flex items-center gap-1">
							<Layers3 className="size-3" />
							{citation.sectionPath}
						</span>
					) : null}
					{citation.page ? (
						<span className="inline-flex items-center gap-1">
							<Hash className="size-3" />
							{citation.page}
						</span>
					) : null}
					{citation.filename ? (
						<span className="inline-flex min-w-0 items-center gap-1 truncate">
							<FileText className="size-3 shrink-0" />
							<span className="truncate">{citation.filename}</span>
						</span>
					) : null}
					{expanded && fullText ? (
						<span className="meta-chip">{fullText.length} 字</span>
					) : null}
				</div>
				{citation.preamble && expanded ? (
					<p className="text-meta border-l-2 border-cite/40 bg-muted/45 px-2.5 py-2 text-muted-foreground">
						定位 {citation.preamble}
					</p>
				) : null}
				{expanded ? (
					<ScrollArea className="evidence-surface h-[min(45vh,24rem)]">
						<p className="text-answer whitespace-pre-wrap px-3 py-3 text-foreground/90">
							{fullText || "（无正文）"}
						</p>
					</ScrollArea>
				) : !compact ? (
					<p className="text-ui line-clamp-2 text-muted-foreground">
						{preview || "（无预览）"}
					</p>
				) : null}
				{showDiagnostics ? (
					<details className="group border-t border-border/70 pt-2">
						<summary className="cursor-pointer list-none text-meta font-mono text-muted-foreground transition-colors hover:text-foreground">
							检索诊断
						</summary>
						<div className="mt-2 flex flex-wrap gap-3">
							<ScoreBar label="rank" value={citation.score} tone="cite" />
							{citation.denseScore != null ? (
								<ScoreBar
									label="dense"
									value={citation.denseScore}
									tone="primary"
								/>
							) : null}
							{citation.bm25Score != null ? (
								<ScoreBar
									label="bm25"
									value={citation.bm25Score}
									tone="survey"
								/>
							) : null}
							{citation.rrfScore != null ? (
								<ScoreBar
									label="rrf"
									value={citation.rrfScore}
									tone="cite"
									barScale={10}
								/>
							) : null}
						</div>
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
		"w-full rounded-md border px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow]",
		active
			? "border-cite/45 bg-cite/8 shadow-sm"
			: "border-border/80 bg-background/90 hover:border-cite/30 hover:bg-card",
		!onSelect && "cursor-default hover:border-cite/45 hover:bg-cite/8",
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
			onClick={() => onSelect(citation)}
			className={className}
		>
			{body}
		</button>
	);
}
