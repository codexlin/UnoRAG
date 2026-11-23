"use client";

import { CircleAlert, CircleHelp, CircleStop } from "lucide-react";
import { motion } from "motion/react";
import { AskAnswerActions } from "@/components/app/ask/ask-answer-actions";
import { AskAnswerSources } from "@/components/app/ask/ask-answer-sources";
import type { LocalTurn } from "@/components/app/ask/ask-turn-state";
import { MarkdownAnswer } from "@/components/app/markdown-answer";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
	Message,
	MessageContent,
	MessageGroup,
	MessageHeader,
} from "@/components/ui/message";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import { formatDateTime } from "@/lib/format";
import { useInterfaceText } from "@/lib/i18n/provider";
import type { UiCitation } from "@/lib/ui-types";

type AskConversationListProps = {
	activeCitation: UiCitation | null;
	activeCitationTurnId: string | null;
	canAsk: boolean;
	isStreaming: boolean;
	onCancel: () => void;
	onOpenCitation: (citation: UiCitation, turnId: string) => void;
	onOpenTrace: (turn: LocalTurn) => void;
	onRetry: (turn: LocalTurn) => void;
	reduceMotion: boolean | null;
	turns: LocalTurn[];
};

function RetrievalNotice({ turn }: { turn: LocalTurn }) {
	const t = useInterfaceText();
	const notices: string[] = [];
	if (turn.hybridFailed) {
		notices.push(
			turn.retrievalMode === "dense" || !turn.usedHybrid
				? t(
						"hybrid 失败，已回退 dense",
						"Hybrid search failed; using dense search",
					)
				: t("hybrid 失败", "Hybrid search failed"),
		);
	}
	if (turn.rerankFailed)
		notices.push(
			t("rerank 失败，已跳过重排", "Reranking failed and was skipped"),
		);
	if (turn.persistError)
		notices.push(
			t(
				`归档写入失败：${turn.persistError}`,
				`Couldn't archive: ${turn.persistError}`,
			),
		);
	if (notices.length === 0) return null;

	return (
		<div className="mt-2 space-y-1">
			{notices.map((notice) => (
				<p
					key={notice}
					className="rounded-md border border-survey/35 bg-warning px-3 py-2 text-xs text-warning-foreground"
				>
					{notice}
				</p>
			))}
		</div>
	);
}

export function AskConversationList({
	activeCitation,
	activeCitationTurnId,
	canAsk,
	isStreaming,
	onCancel,
	onOpenCitation,
	onOpenTrace,
	onRetry,
	reduceMotion,
	turns,
}: AskConversationListProps) {
	const t = useInterfaceText();
	return (
		<>
			{turns.map((turn, turnIndex) => (
				<MessageScrollerItem
					key={turn.id}
					messageId={turn.id}
					scrollAnchor={!turn.restored}
					data-turn-id={turn.id}
				>
					<motion.div
						className="min-w-0"
						initial={reduceMotion ? false : { opacity: 0, y: 4 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{
							duration: 0.18,
							ease: [0.22, 1, 0.36, 1],
						}}
					>
						<MessageGroup className="gap-5">
							<Message align="end">
								<MessageContent>
									<MessageHeader className="justify-end gap-3">
										<span>
											{t("提问", "Question")} {turnIndex + 1}
										</span>
										{turn.startedAt ? (
											<span>{formatDateTime(turn.startedAt)}</span>
										) : null}
									</MessageHeader>
									<Bubble align="end" variant="muted">
										<BubbleContent className="text-answer [overflow-wrap:anywhere]">
											{turn.question}
										</BubbleContent>
									</Bubble>
								</MessageContent>
							</Message>

							<Message>
								<MessageContent className="gap-3">
									<article
										className="min-w-0 border-t border-border/60 pt-4"
										aria-label={t(
											`回答 ${turnIndex + 1}`,
											`Answer ${turnIndex + 1}`,
										)}
									>
										<div className="flex flex-wrap items-center justify-between gap-2">
											<p className="flex min-h-7 items-center gap-2 text-sm font-medium text-foreground">
												{turn.error ? (
													<CircleAlert
														className="size-4 text-destructive"
														aria-hidden
													/>
												) : turn.refused ? (
													<CircleHelp
														className="size-4 text-survey"
														aria-hidden
													/>
												) : turn.cancelled ? (
													<CircleStop
														className="size-4 text-muted-foreground"
														aria-hidden
													/>
												) : null}
												<span>
													{turn.error
														? t("请求失败", "Request failed")
														: turn.refused
															? turn.refuseReason === "weak_match"
																? t("证据不足", "Insufficient evidence")
																: t("未能回答", "No answer")
															: turn.cancelled
																? t("已停止", "Stopped")
																: t("回答", "Answer")}
												</span>
											</p>
											{turn.pending ? (
												<span
													role="status"
													className="text-xs text-muted-foreground"
												>
													{t("处理中…", "Processing…")}
												</span>
											) : null}
										</div>

										{turn.pending && !turn.answer && !turn.evidenceReady ? (
											<p
												className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"
												role="status"
											>
												<span className="inline-block size-1.5 animate-pulse rounded-full bg-evidence" />
												{t(
													"正在检索并整理引用来源…",
													"Retrieving evidence and organizing sources…",
												)}
											</p>
										) : null}
										{turn.error ? (
											<p
												className="mt-2 border-l-2 border-destructive pl-3 text-sm text-destructive"
												role="alert"
											>
												{turn.error}
											</p>
										) : null}
										{turn.cancelled && !turn.answer ? (
											<p className="mt-2 text-sm text-muted-foreground">
												{t(
													"已停止生成。可重试本问题，或继续提问。",
													"Generation stopped. Retry this question or ask another.",
												)}
											</p>
										) : null}
										<RetrievalNotice turn={turn} />
										{turn.answer ? (
											<MarkdownAnswer
												content={turn.answer}
												citations={turn.citations}
												onCite={(citation) => onOpenCitation(citation, turn.id)}
												pending={turn.pending}
												enhanced={!turn.pending}
											/>
										) : null}
										{turn.cancelled && turn.answer ? (
											<p className="mt-2 text-xs text-muted-foreground">
												{t(
													"生成已中止 · 保留已输出内容",
													"Generation stopped · partial answer kept",
												)}
											</p>
										) : null}
										{turn.pending && turn.evidenceReady && !turn.answer ? (
											<p className="mt-2 text-sm text-muted-foreground">
												{t(
													"引用来源已就绪，正在生成回答…",
													"Sources found. Generating an answer…",
												)}
												<span className="ml-0.5 inline-block h-4 w-1 animate-pulse bg-evidence/70 align-text-bottom" />
											</p>
										) : null}
										<AskAnswerActions
											turn={turn}
											canAsk={canAsk}
											isStreaming={isStreaming}
											onCancel={onCancel}
											onRetry={onRetry}
											onOpenTrace={onOpenTrace}
										/>
									</article>

									<AskAnswerSources
										turn={turn}
										activeCitation={activeCitation}
										activeCitationTurnId={activeCitationTurnId}
										onOpenCitation={onOpenCitation}
									/>
								</MessageContent>
							</Message>
						</MessageGroup>
					</motion.div>
				</MessageScrollerItem>
			))}
		</>
	);
}
