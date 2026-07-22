"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { MarkdownAnswer } from "@/components/app/markdown-answer";
import { buttonVariants } from "@/components/ui/button";
import { type ApiArchiveTurn, fetchArchive, isAbortError } from "@/lib/api";
import { cn } from "@/lib/utils";

function formatTime(value: string) {
	try {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return value;
		return date.toLocaleString("zh-CN", {
			month: "numeric",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return value;
	}
}

function preview(text: string, max = 96) {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= max) return compact;
	return `${compact.slice(0, max)}…`;
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
				setError("无法加载档案（API 不可用或尚未写入回合）。");
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
					<p className="font-mono text-[10px] tracking-[0.16em] text-cite uppercase">
						Archive
					</p>
					<p className="text-sm font-medium text-foreground">历史问答</p>
				</div>
				<div className="flex-1 overflow-y-auto p-2">
					{loading ? (
						<p className="px-2 py-3 text-sm text-muted-foreground">加载中…</p>
					) : error ? (
						<p className="px-2 py-3 text-sm text-muted-foreground">{error}</p>
					) : turns.length === 0 ? (
						<p className="px-2 py-3 text-sm text-muted-foreground">
							还没有可回看的回合。去问答台提问后会自动归档。
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
										<p className="line-clamp-2 text-sm text-foreground">
											{turn.question}
										</p>
										<p className="mt-1 font-mono text-[10px] text-muted-foreground">
											{formatTime(turn.created_at)}
											{turn.refused ? " · 拒答" : ""}
											{` · ${turn.citations.length} 证据`}
										</p>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			</aside>

			<section className="flex min-w-0 flex-1 flex-col overflow-y-auto px-5 py-6">
				{selected ? (
					<div className="mx-auto w-full max-w-2xl space-y-4">
						<div>
							<p className="font-mono text-[10px] tracking-[0.16em] text-cite uppercase">
								Turn · {selected.mode}
							</p>
							<h2 className="font-heading mt-1 text-2xl font-semibold tracking-tight">
								{selected.question}
							</h2>
							<p className="mt-1 font-mono text-[11px] text-muted-foreground">
								{formatTime(selected.created_at)}
								{selected.library_id ? ` · ${selected.library_id}` : ""}
								{selected.refused
									? ` · ${selected.refuse_reason || "refused"}`
									: ""}
							</p>
						</div>
						<article className="rounded-md border border-border/80 bg-card/90 px-4 py-4 shadow-sm">
							<p className="font-mono text-[10px] tracking-[0.14em] text-cite uppercase">
								Answer
							</p>
							<MarkdownAnswer
								content={selected.answer}
								citations={selected.citations.map((citation) => {
									const text =
										citation.body || citation.text || citation.snippet || "";
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
										docId: citation.doc_id ?? undefined,
										chunkIndex: citation.chunk_index ?? undefined,
										filename: citation.filename ?? undefined,
									};
								})}
								enhanced
							/>
						</article>
						{selected.citations.length > 0 ? (
							<section className="space-y-2">
								<p className="font-mono text-[11px] text-muted-foreground">
									当时依据 {selected.citations.length} 条证据
								</p>
								<ul className="space-y-2">
									{selected.citations.map((citation) => {
										const fullText = citation.text || citation.snippet || "";
										return (
											<li
												key={citation.id}
												className="cite-rail rounded-md bg-background/70 py-3 pr-3"
											>
												<p className="font-mono text-[11px] text-cite">
													[{citation.index}] · {citation.title}
													{citation.page ? ` · ${citation.page}` : ""}
													{citation.section_path
														? ` · ${citation.section_path}`
														: ""}
												</p>
												<div className="mt-1 max-h-56 overflow-y-auto rounded-md border border-border/50 bg-card/30 px-2 py-1.5">
													<p className="whitespace-pre-wrap text-sm leading-6 text-foreground/90">
														{fullText}
													</p>
												</div>
												{fullText.length > 180 ? (
													<p className="mt-1 font-mono text-[10px] text-muted-foreground">
														全文 {fullText.length} 字 · 预览{" "}
														{preview(fullText, 48)}
													</p>
												) : null}
											</li>
										);
									})}
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
							回到问答台
						</Link>
					</div>
				) : (
					<div className="mx-auto max-w-md py-16 text-center">
						<p className="font-mono text-xs tracking-[0.2em] text-cite uppercase">
							Archive
						</p>
						<h2 className="font-heading mt-2 text-2xl font-semibold">
							选择左侧回合回看
						</h2>
						<p className="mt-2 text-sm leading-6 text-muted-foreground">
							档案保存问题、答案与当时引用的证据片段，便于核对与复盘。
						</p>
					</div>
				)}
			</section>
		</div>
	);
}
