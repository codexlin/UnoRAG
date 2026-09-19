"use client";

import { Activity, RefreshCw, Square } from "lucide-react";
import { motion } from "motion/react";

import { hasAskTrace } from "@/components/app/ask-trace-drawer";
import type { LocalTurn } from "@/components/app/ask-turn-state";
import { CitationSourceCard } from "@/components/app/citation-source-card";
import { MarkdownAnswer } from "@/components/app/markdown-answer";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ApiRetrievalDebug } from "@/lib/api";
import { formatDateTime, formatDurationMs } from "@/lib/format";
import type { UiCitation } from "@/lib/ui-types";
import { cn } from "@/lib/utils";

type AskConversationListProps = {
	activeCitation: UiCitation | null;
	canAsk: boolean;
	isStreaming: boolean;
	onCancel: () => void;
	onOpenCitation: (citation: UiCitation) => void;
	onOpenTrace: (
		debug: ApiRetrievalDebug,
		clientDurationMs?: number | null,
	) => void;
	onRetry: (turn: LocalTurn) => void;
	reduceMotion: boolean | null;
	turns: LocalTurn[];
};

function RetrievalNotice({ turn }: { turn: LocalTurn }) {
	const notices: string[] = [];
	if (turn.hybridFailed) {
		notices.push(
			turn.retrievalMode === "dense" || !turn.usedHybrid
				? "hybrid 失败，已回退 dense"
				: "hybrid 失败",
		);
	}
	if (turn.rerankFailed) notices.push("rerank 失败，已跳过重排");
	if (turn.persistError) notices.push(`归档写入失败：${turn.persistError}`);
	if (notices.length === 0) return null;

	return (
		<div className="mt-2 space-y-1">
			{notices.map((notice) => (
				<p
					key={notice}
					className="rounded-md border border-survey/35 bg-accent px-2.5 py-1.5 font-mono text-[11px] text-accent-foreground"
				>
					{notice}
				</p>
			))}
		</div>
	);
}

function canRetryTurn(turn: LocalTurn): boolean {
	if (turn.pending) return false;
	return Boolean(turn.error || turn.cancelled || turn.refused);
}

export function AskConversationList({
	activeCitation,
	canAsk,
	isStreaming,
	onCancel,
	onOpenCitation,
	onOpenTrace,
	onRetry,
	reduceMotion,
	turns,
}: AskConversationListProps) {
	return (
		<ul className="mx-auto flex max-w-4xl flex-col gap-10">
			{turns.map((turn, turnIndex) => (
				<motion.li
					key={turn.id}
					className="space-y-4"
					initial={reduceMotion ? false : { opacity: 0, y: 8 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{
						duration: 0.28,
						delay: Math.min(turnIndex, 4) * 0.035,
						ease: [0.22, 1, 0.36, 1],
					}}
				>
					<header className="border-b border-border/80 pb-3">
						<div className="mb-2 flex items-center justify-between gap-3 font-mono text-[11px] text-muted-foreground">
							<span>QUERY {String(turnIndex + 1).padStart(2, "0")}</span>
							{turn.startedAt ? (
								<span>{formatDateTime(turn.startedAt)}</span>
							) : null}
						</div>
						<p className="text-lg font-medium leading-7 text-foreground">
							{turn.question}
						</p>
					</header>

					<div className="space-y-3">
						<div className="min-w-0 space-y-3">
							<article className="workbench-surface border-l-2 border-l-cite px-4 py-4 sm:px-5">
								<div className="flex flex-wrap items-center justify-between gap-2">
									<p className="text-meta font-mono tracking-[0.12em] text-cite uppercase">
										{turn.refused
											? "Refused"
											: turn.cancelled
												? "Cancelled"
												: "Answer"}
										{turn.mode ? ` · ${turn.mode}` : ""}
									</p>
									<div className="flex flex-wrap gap-1.5">
										{turn.pending ? (
											<span className="meta-chip animate-pulse text-cite">
												处理中…
											</span>
										) : null}
										{turn.cancelled ? (
											<span className="meta-chip text-survey">已取消</span>
										) : null}
										{turn.durationMs != null ? (
											<span
												className="meta-chip text-foreground/80"
												title="浏览器端到端：点发送到回答完成（含网络）"
											>
												{formatDurationMs(turn.durationMs)}
											</span>
										) : null}
										{turn.citations.length > 0 ? (
											<span className="meta-chip">
												{turn.citations.length} 条依据
											</span>
										) : null}
										{hasAskTrace(turn.retrievalDebug) ? (
											<Tooltip>
												<TooltipTrigger
													render={
														<button
															type="button"
															className={cn(
																"meta-chip inline-flex cursor-pointer items-center gap-1 border-cite/45 bg-cite/12 font-medium text-cite shadow-[0_0_0_1px_color-mix(in_oklab,var(--cite)_18%,transparent)]",
																"transition-colors hover:border-cite/70 hover:bg-cite/20 hover:text-cite",
															)}
															aria-label="查看请求链路：路由、检索、裁决与生成各阶段耗时"
															onClick={() => {
																if (turn.retrievalDebug) {
																	onOpenTrace(
																		turn.retrievalDebug,
																		turn.durationMs,
																	);
																}
															}}
														>
															<Activity
																className="size-3 shrink-0"
																aria-hidden
															/>
															链路
														</button>
													}
												/>
												<TooltipContent side="top" className="max-w-[16rem]">
													查看请求链路：路由 / 检索 / 裁决 / 生成各阶段耗时与
													trace_id
												</TooltipContent>
											</Tooltip>
										) : null}
									</div>
								</div>

								{turn.pending && !turn.answer && !turn.evidenceReady ? (
									<p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
										<span className="inline-block size-1.5 animate-pulse rounded-full bg-cite" />
										正在检索并整理引用来源…
									</p>
								) : turn.error ? (
									<p className="mt-2 text-sm text-destructive">
										{turn.error}
										{turn.durationMs != null
											? ` · ${formatDurationMs(turn.durationMs)}`
											: ""}
									</p>
								) : (
									<>
										{turn.cancelled && !turn.answer ? (
											<p className="mt-2 text-sm text-muted-foreground">
												已停止生成。可重试本问题，或继续提问。
											</p>
										) : null}
										{turn.refused ? (
											<p className="mt-2 font-mono text-[11px] text-survey">
												{turn.refuseReason === "weak_match"
													? "弱相关 · 未调用生成"
													: "无命中 · 未调用生成"}
											</p>
										) : null}
										<RetrievalNotice turn={turn} />
										{turn.answer ? (
											<>
												<MarkdownAnswer
													content={turn.answer}
													citations={turn.citations}
													onCite={onOpenCitation}
													pending={turn.pending}
													enhanced={!turn.pending}
												/>
												{turn.cancelled ? (
													<p className="mt-2 font-mono text-[11px] text-muted-foreground">
														生成已中止 · 保留已输出内容
													</p>
												) : null}
											</>
										) : turn.pending ? (
											<p className="mt-2 text-sm text-muted-foreground">
												引用来源已就绪，正在生成回答…
												<span className="ml-0.5 inline-block h-4 w-1 animate-pulse bg-cite/70 align-text-bottom" />
											</p>
										) : null}
									</>
								)}
								{turn.pending ? (
									<div className="mt-3">
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={onCancel}
											className="rounded-md"
										>
											<Square
												data-icon="inline-start"
												className="size-3 fill-current"
											/>
											停止生成
										</Button>
									</div>
								) : null}
							</article>

							{canRetryTurn(turn) ? (
								<div>
									<Button
										type="button"
										variant="outline"
										size="sm"
										disabled={!canAsk || isStreaming}
										onClick={() => onRetry(turn)}
										className="rounded-md"
									>
										<RefreshCw data-icon="inline-start" />
										重试
									</Button>
								</div>
							) : null}

							{turn.citations.length > 0 ? (
								<section className="space-y-2 border-t border-border/70 pt-3">
									<p className="font-mono text-[11px] text-muted-foreground">
										回答依据 · {turn.citations.length} 条
										{turn.completedAt
											? ` · 完成于 ${formatDateTime(turn.completedAt)}`
											: ""}
									</p>
									<ul className="grid gap-2 sm:grid-cols-2">
										{turn.citations.map((citation) => (
											<li key={citation.id}>
												<CitationSourceCard
													citation={citation}
													active={activeCitation?.id === citation.id}
													onSelect={onOpenCitation}
													compact
												/>
											</li>
										))}
									</ul>
								</section>
							) : turn.refused && !turn.pending && !turn.error ? (
								<p className="font-mono text-[11px] text-muted-foreground">
									无可用引用来源
								</p>
							) : null}
						</div>
					</div>
				</motion.li>
			))}
		</ul>
	);
}
