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
	type ApiThread,
	type ApiThreadDetail,
	fetchThread,
	fetchThreads,
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
	const [threads, setThreads] = useState<ApiThread[]>([]);
	const [selectedId, setSelectedId] = useState("");
	const [detail, setDetail] = useState<ApiThreadDetail | null>(null);
	const [selectedTurnId, setSelectedTurnId] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [detailLoading, setDetailLoading] = useState(false);

	useEffect(() => {
		const controller = new AbortController();
		void (async () => {
			setLoading(true);
			try {
				const items = await fetchThreads({
					limit: 40,
					signal: controller.signal,
				});
				if (controller.signal.aborted) return;
				setThreads(items);
				setSelectedId((prev) => prev || items[0]?.id || "");
				setError(null);
			} catch (err) {
				if (controller.signal.aborted || isAbortError(err)) return;
				setThreads([]);
				setError("无法加载归档会话（API 不可用或尚未归档）。");
			} finally {
				if (!controller.signal.aborted) setLoading(false);
			}
		})();
		return () => controller.abort();
	}, []);

	useEffect(() => {
		if (!selectedId) {
			setDetail(null);
			setSelectedTurnId("");
			return;
		}
		const controller = new AbortController();
		void (async () => {
			setDetailLoading(true);
			try {
				const item = await fetchThread(selectedId, controller.signal);
				if (controller.signal.aborted) return;
				setDetail(item);
				// turns are oldest→newest; default to latest round for review.
				const last = item.turns[item.turns.length - 1];
				setSelectedTurnId(last?.id || item.turns[0]?.id || "");
				setError(null);
			} catch (err) {
				if (controller.signal.aborted || isAbortError(err)) return;
				setDetail(null);
				setError("无法加载该会话的消息。");
			} finally {
				if (!controller.signal.aborted) setDetailLoading(false);
			}
		})();
		return () => controller.abort();
	}, [selectedId]);

	const selectedTurn: ApiArchiveTurn | null =
		detail?.turns.find((item) => item.id === selectedTurnId) ??
		detail?.turns[0] ??
		null;

	return (
		<div className="flex min-h-0 flex-1 overflow-hidden">
			<aside className="flex w-[320px] shrink-0 flex-col border-r border-border/80 bg-card/70">
				<div className="border-b border-border/70 px-4 py-3">
					<p className="text-meta font-mono tracking-[0.16em] text-cite uppercase">
						Archive
					</p>
					<p className="text-[0.9375rem] font-medium leading-snug text-foreground">
						归档会话
					</p>
					<p className="text-meta mt-1 font-mono text-muted-foreground">
						共 {loading ? "…" : threads.length} 个
					</p>
				</div>
				<ScrollArea className="min-h-0 flex-1">
					<div className="p-2">
						{loading ? (
							<p className="text-ui px-2 py-3 text-muted-foreground">加载中…</p>
						) : error && threads.length === 0 ? (
							<p className="text-ui px-2 py-3 text-muted-foreground">{error}</p>
						) : threads.length === 0 ? (
							<p className="text-ui px-2 py-3 text-muted-foreground">
								还没有归档会话。在智能问答点「归档」后会出现在这里。
							</p>
						) : (
							<ul className="space-y-1">
								{threads.map((thread) => (
									<li key={thread.id}>
										<button
											type="button"
											onClick={() => setSelectedId(thread.id)}
											className={cn(
												"w-full rounded-md border px-3 py-2.5 text-left transition-colors",
												selectedId === thread.id
													? "border-cite/40 bg-cite/10"
													: "border-transparent hover:border-border hover:bg-background/70",
											)}
										>
											<p className="line-clamp-2 text-[0.9375rem] leading-snug text-foreground">
												{thread.title}
											</p>
											<p className="text-meta mt-1 font-mono text-muted-foreground">
												{formatDateTime(thread.updated_at)}
												{` · ${thread.turn_count} 轮`}
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
					{detailLoading ? (
						<p className="text-ui text-muted-foreground">加载会话…</p>
					) : detail ? (
						<div className="mx-auto w-full max-w-2xl space-y-4">
							<div className="flex flex-wrap items-start justify-between gap-3">
								<div>
									<p className="text-meta font-mono tracking-[0.16em] text-cite uppercase">
										Thread
									</p>
									<h2 className="font-heading mt-1 text-xl font-semibold tracking-tight sm:text-2xl">
										{detail.title}
									</h2>
									<div className="mt-2 flex flex-wrap gap-1.5">
										<span className="meta-chip">
											{formatDateTime(detail.updated_at)}
										</span>
										{detail.library_id ? (
											<span className="meta-chip">{detail.library_id}</span>
										) : null}
										<span className="meta-chip">{detail.turn_count} 轮</span>
									</div>
								</div>
								<Link
									href={`/app/ask?thread=${encodeURIComponent(detail.id)}`}
									className={cn(
										buttonVariants({ variant: "default" }),
										"rounded-md",
									)}
								>
									继续对话
								</Link>
							</div>

							{detail.turns.length > 1 ? (
								<div className="flex flex-wrap gap-1.5">
									{detail.turns.map((turn, index) => (
										<button
											key={turn.id}
											type="button"
											onClick={() => setSelectedTurnId(turn.id)}
											className={cn(
												"rounded-md border px-2.5 py-1 text-xs transition-colors",
												(selectedTurn?.id || "") === turn.id
													? "border-cite/40 bg-cite/10 text-cite"
													: "border-border/70 text-muted-foreground hover:bg-background",
											)}
										>
											第 {index + 1} 轮
										</button>
									))}
								</div>
							) : null}

							{selectedTurn ? (
								<>
									<div>
										<p className="text-meta font-mono tracking-[0.14em] text-cite uppercase">
											Question
										</p>
										<p className="mt-1 text-[1.05rem] font-medium leading-snug">
											{selectedTurn.question}
										</p>
									</div>
									<article className="rounded-2xl border border-border/80 bg-card/90 px-4 py-4 shadow-sm">
										<p className="text-meta font-mono tracking-[0.14em] text-cite uppercase">
											Answer
										</p>
										<MarkdownAnswer
											content={selectedTurn.answer}
											citations={selectedTurn.citations.map(toUiCitation)}
											enhanced
										/>
									</article>
									{selectedTurn.citations.length > 0 ? (
										<section className="space-y-2">
											<p className="text-meta font-mono text-muted-foreground">
												引用来源 · {selectedTurn.citations.length} 条
											</p>
											<ul className="space-y-2">
												{selectedTurn.citations.map((citation) => (
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
								</>
							) : (
								<p className="text-ui text-muted-foreground">该会话还没有消息。</p>
							)}
						</div>
					) : (
						<div className="mx-auto max-w-md py-16 text-center">
							<p className="text-meta font-mono tracking-[0.2em] text-cite uppercase">
								Archive
							</p>
							<h2 className="font-heading mt-2 text-2xl font-semibold">
								选择左侧会话回看
							</h2>
							<p className="text-answer mt-2 text-muted-foreground">
								仅显示已归档会话。可打开回放，或继续对话。
							</p>
						</div>
					)}
				</section>
			</ScrollArea>
		</div>
	);
}
