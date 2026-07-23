"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { CitationSourceCard } from "@/components/app/citation-source-card";
import { MarkdownAnswer } from "@/components/app/markdown-answer";
import { buttonVariants } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	type ApiArchiveTurn,
	type ApiCitation,
	fetchArchive,
	isAbortError,
} from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { UiCitation } from "@/lib/ui-types";
import { cn } from "@/lib/utils";

function toUiCitation(citation: ApiCitation): UiCitation {
	const text = citation.body || citation.text || citation.snippet || "";
	return {
		id: citation.id,
		index: citation.index,
		title: citation.title,
		page: citation.page ?? undefined,
		sectionPath: citation.section_path ?? undefined,
		preamble: citation.preamble ?? undefined,
		snippet: citation.snippet || text.slice(0, 280),
		text,
		score: citation.score,
		denseScore: citation.dense_score,
		bm25Score: citation.bm25_score,
		rrfScore: citation.rrf_score,
		usedRerank: Boolean(citation.used_rerank),
		usedHybrid: Boolean(citation.used_hybrid),
		docId: citation.doc_id ?? undefined,
		chunkIndex: citation.chunk_index ?? undefined,
		filename: citation.filename ?? undefined,
	};
}

export function ArchivePanel() {
	const [turns, setTurns] = useState<ApiArchiveTurn[]>([]);
	const [selectedId, setSelectedId] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		const controller = new AbortController();
		void (async () => {
			setLoading(true);
			try {
				const items = await fetchArchive({
					limit: 40,
					signal: controller.signal,
				});
				if (controller.signal.aborted) return;
				setTurns(items);
				setSelectedId((prev) => prev || items[0]?.id || "");
				setError(null);
			} catch (err) {
				if (controller.signal.aborted || isAbortError(err)) return;
				setTurns([]);
				setError("无法加载会话历史（API 不可用或尚未写入回合）。");
			} finally {
				if (!controller.signal.aborted) setLoading(false);
			}
		})();
		return () => controller.abort();
	}, []);

	const selected = turns.find((item) => item.id === selectedId) ?? null;

	return (
		<div className="flex min-h-0 flex-1 overflow-hidden">
			<aside className="flex w-[320px] shrink-0 flex-col border-r border-border/80 bg-card/70">
				<div className="border-b border-border/70 px-4 py-3">
					<p className="text-meta font-mono tracking-[0.16em] text-cite uppercase">
						History
					</p>
					<p className="text-[0.9375rem] font-medium leading-snug text-foreground">
						会话历史
					</p>
					<p className="text-meta mt-1 font-mono text-muted-foreground">
						共 {loading ? "…" : turns.length} 条
					</p>
				</div>
				<ScrollArea className="min-h-0 flex-1">
					<div className="p-2">
						{loading ? (
							<p className="text-ui px-2 py-3 text-muted-foreground">加载中…</p>
						) : error ? (
							<p className="text-ui px-2 py-3 text-muted-foreground">{error}</p>
						) : turns.length === 0 ? (
							<p className="text-ui px-2 py-3 text-muted-foreground">
								还没有可回看的回合。去智能问答提问后会自动保存。
							</p>
						) : (
							<ul className="space-y-1">
								{turns.map((turn) => (
									<li key={turn.id}>
										<button
											type="button"
											onClick={() => setSelectedId(turn.id)}
											className={cn(
												"w-full rounded-md border px-3 py-2.5 text-left transition-colors",
												selectedId === turn.id
													? "border-cite/40 bg-cite/10"
													: "border-transparent hover:border-border hover:bg-background/70",
											)}
										>
											<p className="line-clamp-2 text-[0.9375rem] leading-snug text-foreground">
												{turn.question}
											</p>
											<p className="text-meta mt-1 font-mono text-muted-foreground">
												{formatDateTime(turn.created_at)}
												{turn.refused ? " · 拒答" : ""}
												{` · ${turn.citations.length} 引用`}
											</p>
										</button>
									</li>
								))}
							</ul>
						)}
					</div>
				</ScrollArea>
			</aside>

			<ScrollArea className="min-h-0 min-w-0 flex-1">
				<section className="px-5 py-6">
					{selected ? (
						<div className="mx-auto w-full max-w-2xl space-y-4">
							<div>
								<p className="text-meta font-mono tracking-[0.16em] text-cite uppercase">
									Turn · {selected.mode}
								</p>
								<h2 className="font-heading mt-1 text-xl font-semibold tracking-tight sm:text-2xl">
									{selected.question}
								</h2>
								<div className="mt-2 flex flex-wrap gap-1.5">
									<span className="meta-chip">
										{formatDateTime(selected.created_at)}
									</span>
									{selected.library_id ? (
										<span className="meta-chip">{selected.library_id}</span>
									) : null}
									<span className="meta-chip">{selected.mode}</span>
									<span className="meta-chip">
										{selected.citations.length} 引用
									</span>
									{selected.refused ? (
										<span className="meta-chip text-survey">
											{selected.refuse_reason || "refused"}
										</span>
									) : null}
								</div>
							</div>
							<article className="rounded-2xl border border-border/80 bg-card/90 px-4 py-4 shadow-sm">
								<p className="text-meta font-mono tracking-[0.14em] text-cite uppercase">
									Answer
								</p>
								<MarkdownAnswer
									content={selected.answer}
									citations={selected.citations.map(toUiCitation)}
									enhanced
								/>
							</article>
							{selected.citations.length > 0 ? (
								<section className="space-y-2">
									<p className="text-meta font-mono text-muted-foreground">
										引用来源 · {selected.citations.length} 条
									</p>
									<ul className="space-y-2">
										{selected.citations.map((citation) => (
											<li key={citation.id}>
												<CitationSourceCard
													citation={toUiCitation(citation)}
													expanded
												/>
											</li>
										))}
									</ul>
								</section>
							) : null}
							<Link
								href="/app/ask"
								className={cn(
									buttonVariants({ variant: "outline" }),
									"rounded-md",
								)}
							>
								回到智能问答
							</Link>
						</div>
					) : (
						<div className="mx-auto max-w-md py-16 text-center">
							<p className="text-meta font-mono tracking-[0.2em] text-cite uppercase">
								History
							</p>
							<h2 className="font-heading mt-2 text-2xl font-semibold">
								选择左侧回合回看
							</h2>
							<p className="text-answer mt-2 text-muted-foreground">
								会话历史保存问题、答案与当时的引用来源，便于核对与复盘。
							</p>
						</div>
					)}
				</section>
			</ScrollArea>
		</div>
	);
}
