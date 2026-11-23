"use client";

import { Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	TraceCollapsible,
	TraceCollapsibleContent,
	TraceCollapsibleTrigger,
} from "@/components/ui/trace";
import type {
	RetrievalInspection,
	RetrievalInspectionCandidate,
} from "@/core/retrieval/retrieval-service";
import type { ApiAskTraceDetails } from "@/lib/api";
import { useInterfaceLanguage, useInterfaceText } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

const OUTCOMES = {
	selected: ["已选中", "Selected"],
	deduped: ["已去重", "Deduplicated"],
	below_threshold: ["低于阈值", "Below threshold"],
	dropped_topk: ["超出 Top K", "Outside top K"],
	dropped_rerank: ["未进入重排结果", "Outside rerank results"],
} as const;

const FILTERS = {
	all: ["全部", "All"],
	selected: ["已选中", "Selected"],
	dropped: ["已淘汰", "Dropped"],
} as const;

function score(value: number | null): string {
	return value === null ? "—" : Number(value.toPrecision(4)).toString();
}

function Candidate({ candidate }: { candidate: RetrievalInspectionCandidate }) {
	const t = useInterfaceText();
	const { locale } = useInterfaceLanguage();
	const [outcomeZh, outcomeEn] = OUTCOMES[candidate.outcome];
	const delta = candidate.rank_delta;
	const rank =
		candidate.rerank_rank == null
			? `#${candidate.coarse_rank}`
			: `#${candidate.coarse_rank} → #${candidate.rerank_rank} (${delta != null && delta > 0 ? "+" : ""}${delta ?? 0})`;
	const page = candidate.page_start ?? candidate.page_end;
	const pageRange =
		page != null && candidate.page_end != null && candidate.page_end !== page
			? `${page}–${candidate.page_end}`
			: page;
	const source = [
		candidate.filename !== candidate.title ? candidate.filename : null,
		candidate.section_path,
		pageRange === null ? null : t(`页 ${pageRange}`, `p. ${pageRange}`),
		candidate.record_type,
	].filter(Boolean);
	const scores = [
		[t("稠密", "Dense"), candidate.dense_score],
		[t("稀疏", "Sparse"), candidate.sparse_score],
		["RRF", candidate.rrf_score],
		[t("重排", "Rerank"), candidate.rerank_score],
	] as const;
	return (
		<li className="space-y-2 py-3">
			<div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
				<h4 className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">
					{candidate.title}
				</h4>
				<div className="flex flex-wrap items-center gap-2">
					<span className="rounded-md bg-muted px-2 py-1 font-mono text-xs tabular-nums">
						{rank}
					</span>
					<span
						className={cn(
							"rounded-md border px-2 py-1 text-xs",
							candidate.outcome === "selected"
								? "border-evidence/35 text-evidence"
								: "text-muted-foreground",
						)}
					>
						{t(outcomeZh, outcomeEn)}
					</span>
				</div>
			</div>
			<p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
				{source.join(" · ")}
			</p>
			<dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-4">
				{scores.map(([label, value]) => (
					<div key={label} className="flex flex-wrap gap-x-1.5">
						<dt className="text-muted-foreground">{label}</dt>
						<dd className="font-mono tabular-nums">{score(value)}</dd>
					</div>
				))}
			</dl>
			{candidate.final_rank !== null || candidate.parent_expanded ? (
				<div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
					{candidate.final_rank !== null ? (
						<span>
							{t(
								`最终排名 #${candidate.final_rank}`,
								`Final rank #${candidate.final_rank}`,
							)}
						</span>
					) : null}
					{candidate.parent_expanded ? (
						<span>
							{t("上下文扩展", "Context expansion")}{" "}
							<span className="font-mono tabular-nums">
								{candidate.chars_before_expand.toLocaleString(locale)} →{" "}
								{candidate.chars_after_expand.toLocaleString(locale)}
							</span>{" "}
							{t("字符", "chars")}
						</span>
					) : null}
				</div>
			) : null}
			{candidate.preview ? (
				<TraceCollapsible>
					<TraceCollapsibleTrigger className="gap-2 px-2 text-xs hover:bg-muted/40">
						{t("片段预览", "Snippet preview")}
					</TraceCollapsibleTrigger>
					<TraceCollapsibleContent className="mt-0 text-sm [overflow-wrap:anywhere]">
						{candidate.preview}
					</TraceCollapsibleContent>
				</TraceCollapsible>
			) : null}
		</li>
	);
}

function RetrievalCall({
	inspection,
	filter,
	defaultOpen,
}: {
	inspection: RetrievalInspection;
	filter: keyof typeof FILTERS;
	defaultOpen: boolean;
}) {
	const t = useInterfaceText();
	const candidates = inspection.candidates.filter(
		(candidate) =>
			filter === "all" ||
			(candidate.outcome === "selected") === (filter === "selected"),
	);
	return (
		<TraceCollapsible defaultOpen={defaultOpen} className="border-b">
			<TraceCollapsibleTrigger className="w-full justify-between gap-3 px-2 py-2 hover:bg-muted/40">
				<span className="min-w-0 text-sm font-medium text-foreground [overflow-wrap:anywhere]">
					{inspection.query}
				</span>
			</TraceCollapsibleTrigger>
			<TraceCollapsibleContent className="m-0 border-l-0 px-2">
				<p className="flex flex-wrap gap-x-3 gap-y-1 border-b pb-2 text-xs text-muted-foreground">
					<span>
						{inspection.mode === "hybrid"
							? t("混合", "Hybrid")
							: t("稠密", "Dense")}
					</span>
					<span>
						{inspection.usedRerank
							? t("已重排", "Reranked")
							: t("未重排", "No rerank")}
					</span>
					<span>Top K {inspection.topK}</span>
					<span>
						{t("证据阈值", "Evidence threshold")}{" "}
						{score(inspection.evidenceThreshold)}
					</span>
					<span>
						{t(
							`${candidates.length} / ${inspection.candidates.length} 项`,
							`${candidates.length} / ${inspection.candidates.length} candidates`,
						)}
					</span>
				</p>
				{candidates.length ? (
					<ul className="divide-y">
						{candidates.map((candidate) => (
							<Candidate key={candidate.id} candidate={candidate} />
						))}
					</ul>
				) : (
					<p className="py-3 text-sm text-muted-foreground">
						{t("没有符合筛选条件的候选。", "No candidates match this filter.")}
					</p>
				)}
			</TraceCollapsibleContent>
		</TraceCollapsible>
	);
}

export function RetrievalInspectionPanel({
	details,
	traceId,
}: {
	details: ApiAskTraceDetails;
	traceId: string | null;
}) {
	const t = useInterfaceText();
	const [filter, setFilter] = useState<keyof typeof FILTERS>("all");
	const inspections = details.retrieval_inspection;

	async function copySnapshot() {
		try {
			await navigator.clipboard.writeText(
				JSON.stringify({ trace_id: traceId, ...details }, null, 2),
			);
			toast.success(t("已复制排查快照", "Snapshot copied"));
		} catch {
			toast.error(t("复制失败", "Copy failed"));
		}
	}

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				{inspections.length ? (
					<fieldset
						aria-label={t("筛选候选", "Filter candidates")}
						className="flex flex-wrap gap-1.5"
					>
						{(Object.keys(FILTERS) as (keyof typeof FILTERS)[]).map(
							(option) => (
								<Button
									key={option}
									type="button"
									variant={option === filter ? "secondary" : "outline"}
									size="sm"
									className="min-h-11 min-w-11 rounded-full"
									aria-pressed={option === filter}
									onClick={() => setFilter(option)}
								>
									{t(FILTERS[option][0], FILTERS[option][1])}
								</Button>
							),
						)}
					</fieldset>
				) : null}
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="min-h-11"
					onClick={() => void copySnapshot()}
				>
					<Copy data-icon="inline-start" />
					{t("复制排查快照", "Copy snapshot")}
				</Button>
			</div>
			{inspections.length ? (
				<>
					<p className="text-xs text-muted-foreground">
						{t(
							"每次检索最多显示 20 个候选。",
							"Up to 20 coarse candidates per retrieval call.",
						)}
					</p>
					{inspections.map((inspection, index) => (
						<RetrievalCall
							// biome-ignore lint/suspicious/noArrayIndexKey: A retry can issue the same query. Calls are ordered and immutable.
							key={`${index}:${inspection.query}`}
							inspection={inspection}
							filter={filter}
							defaultOpen={index === 0}
						/>
					))}
				</>
			) : (
				<p className="text-sm text-muted-foreground">
					{t("本轮未进行粗召回。", "This turn ran without coarse retrieval.")}
				</p>
			)}
		</div>
	);
}
