"use client";

import { ChevronDown, FileText, Hash, Layers3 } from "lucide-react";
import { type ReactNode, useState } from "react";

import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { splitMarkdownTableRow } from "@/core/parsing/markdown-table";
import { documentFigureUrl } from "@/lib/api";
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
	const table = expanded ? citationTable(citation, fullText) : null;

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
										{citation.source.row_start + 1}
										{citation.source.row_end != null
											? ` 至 ${citation.source.row_end + 1}`
											: ""}
									</dd>
								</>
							) : null}
						</dl>
						<section className="space-y-2 border-t pt-4">
							<h3 className="text-sm font-medium">来源片段</h3>
							{citation.source?.figure_id &&
							(citation.source?.document_id ||
								citation.source?.doc_id ||
								citation.docId) ? (
								<FigureAssetPreview
									key={`${citation.source.figure_id}:${citation.source.document_version_id ?? ""}`}
									src={documentFigureUrl(
										citation.source.document_id ||
											citation.source.doc_id ||
											citation.docId ||
											"",
										citation.source.figure_id,
										citation.source.document_version_id,
									)}
									alt={preview || citation.title}
								/>
							) : null}
							{table ? (
								<Table
									aria-label={citation.title}
									className="w-max min-w-full text-foreground"
									containerProps={{
										role: "region",
										"aria-label": "表格来源片段",
										tabIndex: 0,
										className: "max-w-full rounded-sm border",
									}}
								>
									<TableHeader className="bg-muted/50">
										<TableRow>
											{table.headers.map((header, index) => (
												// biome-ignore lint/suspicious/noArrayIndexKey: Snapshot columns retain their source order, including duplicate labels.
												<TableHead key={index} scope="col">
													{header}
												</TableHead>
											))}
										</TableRow>
									</TableHeader>
									<TableBody>
										{table.rows.map((row, index) => (
											// biome-ignore lint/suspicious/noArrayIndexKey: Snapshot rows retain their source order, including identical rows.
											<TableRow key={index}>
												{row.map((cell, column) => (
													// biome-ignore lint/suspicious/noArrayIndexKey: Snapshot cells retain their column position.
													<TableCell key={column}>{cell}</TableCell>
												))}
											</TableRow>
										))}
									</TableBody>
								</Table>
							) : (
								<p className="text-answer whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
									{fullText || "未记录来源片段"}
								</p>
							)}
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

function FigureAssetPreview({ src, alt }: { src: string; alt: string }) {
	const [failed, setFailed] = useState(false);
	if (failed) return null;
	return (
		<figure className="overflow-hidden rounded-sm border bg-muted/20 p-2">
			{/* biome-ignore lint/performance/noImgElement: Authenticated figure crops stream dynamically with private no-store cache headers. */}
			<img
				src={src}
				alt={alt}
				loading="lazy"
				decoding="async"
				onError={() => setFailed(true)}
				className="max-h-72 w-auto max-w-full rounded-sm object-contain"
			/>
		</figure>
	);
}

function citationTable(citation: UiCitation, text: string) {
	const { headers, rows } = citation.source ?? {};
	if (headers?.length || rows?.length) {
		return Array.isArray(headers) &&
			headers.length > 0 &&
			headers.every((header) => typeof header === "string") &&
			Array.isArray(rows) &&
			rows.length > 0 &&
			rows.every(
				(row) =>
					Array.isArray(row) &&
					row.length === headers.length &&
					row.every((cell) => typeof cell === "string"),
			)
			? { headers, rows }
			: null;
	}
	const lines = text.trim().split(/\r?\n/).map(splitMarkdownTableRow);
	if (lines.some((line) => !line)) return null;
	const [textHeaders, ...textRows] = lines as string[][];
	const delimiter = textRows[0]?.every((cell) => /^:?-+:?$/.test(cell));
	if (delimiter && textRows[0].length !== textHeaders?.length) return null;
	if (delimiter) textRows.shift();
	if (
		!(
			delimiter ||
			citation.source?.record_type === "table" ||
			citation.source?.table_id
		) ||
		!textHeaders?.some(Boolean) ||
		!textRows.length ||
		textRows.some((row) => row.length !== textHeaders.length)
	)
		return null;
	return { headers: textHeaders, rows: textRows };
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
