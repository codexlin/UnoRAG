"use client";

import {
	ChevronRight,
	PanelRightClose,
	PanelRightOpen,
	Send,
} from "lucide-react";
import Link from "next/link";
import {
	type FormEvent,
	type KeyboardEvent,
	useEffect,
	useMemo,
	useState,
} from "react";

import { MarkdownAnswer } from "@/components/app/markdown-answer";
import { Button, buttonVariants } from "@/components/ui/button";
import { useHealth } from "@/hooks/use-health";
import { useLibraries } from "@/hooks/use-libraries";
import { type ApiCitation, askQuestionStream } from "@/lib/api";
import { formatDateTime, formatDurationMs, formatScore } from "@/lib/format";
import type { UiCitation, UiTurn } from "@/lib/ui-types";
import { cn } from "@/lib/utils";

type LocalTurn = UiTurn & {
	pending?: boolean;
	error?: string;
	topScore?: number | null;
	usedHybrid?: boolean;
	evidenceReady?: boolean;
	hybridFailed?: boolean;
	rerankFailed?: boolean;
	retrievalMode?: string;
	persisted?: boolean;
	persistError?: string | null;
	/** performance.now() mark when request started */
	startedAtMs?: number;
	/** wall-clock when request started */
	startedAt?: number;
	completedAt?: number;
	durationMs?: number;
	/** ms until first citations / evidence event */
	evidenceMs?: number;
};

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
		docId: citation.doc_id ?? undefined,
		chunkIndex: citation.chunk_index ?? undefined,
		filename: citation.filename ?? undefined,
	};
}

function snippetPreview(text: string, max = 28) {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= max) return compact;
	return `${compact.slice(0, max)}…`;
}

function AnswerBody({
	answer,
	citations,
	pending,
	onCite,
}: {
	answer: string;
	citations: UiCitation[];
	pending?: boolean;
	onCite: (citation: UiCitation) => void;
}) {
	return (
		<MarkdownAnswer
			content={answer}
			citations={citations}
			onCite={onCite}
			pending={pending}
			enhanced={!pending}
		/>
	);
}

function RetrievalNotice({ turn }: { turn: LocalTurn }) {
	const notices: string[] = [];
	if (turn.hybridFailed) {
		notices.push(
			turn.retrievalMode === "dense" || !turn.usedHybrid
				? "hybrid 失败，已回退 dense"
				: "hybrid 失败",
		);
	}
	if (turn.rerankFailed) {
		notices.push("rerank 失败，已跳过重排");
	}
	if (turn.persisted === false) {
		notices.push(
			turn.persistError ? `档案未写入：${turn.persistError}` : "档案未写入",
		);
	}
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

export function AskWorkspace() {
	const { libraries, error: libsError } = useLibraries();
	const { apiReady } = useHealth();
	const [libraryId, setLibraryId] = useState("");
	const [input, setInput] = useState("");
	const [sessionId, setSessionId] = useState<string | undefined>();
	const [turns, setTurns] = useState<LocalTurn[]>([]);
	const [activeCitation, setActiveCitation] = useState<UiCitation | null>(null);
	const [drawerOpen, setDrawerOpen] = useState(true);

	useEffect(() => {
		if (!libraryId && libraries[0]?.id) {
			setLibraryId(libraries[0].id);
		}
	}, [libraries, libraryId]);

	const library = useMemo(
		() => libraries.find((item) => item.id === libraryId) ?? null,
		[libraries, libraryId],
	);

	const canAsk = Boolean(library && library.status === "ready" && apiReady);

	function openCitation(citation: UiCitation) {
		setActiveCitation(citation);
		setDrawerOpen(true);
	}

	async function submitQuestion(question: string) {
		const trimmed = question.trim();
		if (!trimmed || !canAsk || !libraryId) return;

		const pendingId = `pending-${Date.now()}`;
		const startedAtMs = performance.now();
		const startedAt = Date.now();
		setTurns((prev) => [
			...prev,
			{
				id: pendingId,
				question: trimmed,
				answer: "",
				citations: [],
				pending: true,
				evidenceReady: false,
				startedAtMs,
				startedAt,
			},
		]);
		setInput("");
		setDrawerOpen(true);

		try {
			await askQuestionStream(
				{
					question: trimmed,
					libraryId,
					sessionId,
				},
				{
					onMeta: (meta) => {
						setSessionId(meta.session_id);
						setTurns((prev) =>
							prev.map((turn) =>
								turn.id === pendingId
									? {
											...turn,
											refused: meta.refused,
											refuseReason: meta.refuse_reason,
											mode: meta.mode,
											hybridFailed: Boolean(meta.hybrid_failed),
											rerankFailed: Boolean(meta.rerank_failed),
											retrievalMode: meta.retrieval_mode,
										}
									: turn,
							),
						);
					},
					onCitations: (citations) => {
						const mapped = citations.map(toUiCitation);
						const evidenceMs = Math.round(performance.now() - startedAtMs);
						setTurns((prev) =>
							prev.map((turn) =>
								turn.id === pendingId
									? {
											...turn,
											citations: mapped,
											evidenceReady: true,
											evidenceMs: turn.evidenceMs ?? evidenceMs,
										}
									: turn,
							),
						);
						setActiveCitation(mapped[0] ?? null);
					},
					onToken: (token) => {
						setTurns((prev) =>
							prev.map((turn) =>
								turn.id === pendingId
									? {
											...turn,
											answer: `${turn.answer}${token}`,
											pending: false,
										}
									: turn,
							),
						);
					},
					onDone: (result) => {
						setSessionId(result.session_id);
						const citations = result.citations.map(toUiCitation);
						const debug = result.retrieval_debug || {};
						const completedAt = Date.now();
						const durationMs = Math.round(performance.now() - startedAtMs);
						setTurns((prev) =>
							prev.map((turn) =>
								turn.id === pendingId
									? {
											id: `turn-${Date.now()}`,
											question: trimmed,
											answer: result.answer,
											citations,
											refused: result.refused,
											refuseReason: result.refuse_reason,
											mode: result.mode,
											pending: false,
											evidenceReady: true,
											startedAt,
											completedAt,
											durationMs,
											evidenceMs: turn.evidenceMs,
											topScore:
												typeof debug.top_score === "number"
													? debug.top_score
													: null,
											usedHybrid: Boolean(debug.used_hybrid),
											hybridFailed: Boolean(
												result.hybrid_failed ?? debug.hybrid_failed,
											),
											rerankFailed: Boolean(
												result.rerank_failed ?? debug.rerank_failed,
											),
											retrievalMode:
												result.retrieval_mode ||
												(typeof debug.retrieval_mode === "string"
													? debug.retrieval_mode
													: undefined),
											persisted: result.persisted !== false,
											persistError: result.persist_error ?? null,
										}
									: turn,
							),
						);
						setActiveCitation(citations[0] ?? null);
					},
					onError: (message) => {
						throw new Error(message);
					},
				},
			);
		} catch (err) {
			const message =
				err instanceof Error ? err.message : "请求失败，请确认 API 已启动";
			const completedAt = Date.now();
			const durationMs = Math.round(performance.now() - startedAtMs);
			setTurns((prev) =>
				prev.map((turn) =>
					turn.id === pendingId
						? {
								id: `turn-${Date.now()}`,
								question: trimmed,
								answer: "",
								citations: [],
								pending: false,
								error: message,
								evidenceReady: false,
								startedAt,
								completedAt,
								durationMs,
							}
						: turn,
				),
			);
			setActiveCitation(null);
		}
	}

	function onSubmit(event: FormEvent) {
		event.preventDefault();
		void submitQuestion(input);
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			void submitQuestion(input);
		}
	}

	const evidenceText = activeCitation?.text || activeCitation?.snippet || "";

	return (
		<div className="flex min-h-0 flex-1">
			<section className="flex min-w-0 flex-1 flex-col">
				<div className="flex flex-wrap items-center gap-3 border-b border-border/70 bg-card/40 px-5 py-3">
					<label className="flex min-w-0 flex-1 flex-col gap-1 sm:max-w-xs">
						<span className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
							当前文库
						</span>
						<select
							value={libraryId}
							onChange={(event) => setLibraryId(event.target.value)}
							className="h-9 rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
						>
							{libraries.map((item) => (
								<option key={item.id} value={item.id}>
									{item.name}
									{item.status === "indexing" ? " · 索引中" : ""}
									{item.status === "empty" ? " · 空" : ""}
								</option>
							))}
						</select>
					</label>
					<div className="flex flex-wrap items-center gap-2">
						{library ? (
							<span className="meta-chip">
								{library.ready_count}/{library.doc_count} 就绪
							</span>
						) : (
							<span className="meta-chip">未选择文库</span>
						)}
						{sessionId ? (
							<span className="meta-chip" title={sessionId}>
								session {sessionId.slice(0, 8)}…
							</span>
						) : null}
						<span className="meta-chip">本轮 {turns.length} 问</span>
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="rounded-md transition-transform active:scale-[0.98]"
							onClick={() => setDrawerOpen((open) => !open)}
						>
							{drawerOpen ? (
								<PanelRightClose data-icon="inline-start" />
							) : (
								<PanelRightOpen data-icon="inline-start" />
							)}
							证据
						</Button>
					</div>
				</div>
				{libsError ? (
					<p className="border-b border-destructive/30 bg-destructive/10 px-5 py-1.5 text-sm text-destructive">
						{libsError}
					</p>
				) : null}

				<div className="flex-1 overflow-y-auto px-5 py-6">
					{turns.length === 0 ? (
						<div className="desk-enter mx-auto flex max-w-xl flex-col gap-4 py-10">
							<p className="font-mono text-xs tracking-[0.2em] text-cite uppercase">
								Ask desk
							</p>
							<h2 className="font-heading text-2xl font-semibold tracking-tight text-foreground">
								{canAsk
									? "对着文库提问，答案旁核对出处"
									: library?.status === "empty"
										? "这本文库还是空的"
										: "文库还在整理中"}
							</h2>
							<p className="desk-enter desk-enter-delay-1 text-sm leading-6 text-muted-foreground">
								{canAsk
									? "流式回答会边生成边显示；每轮会标注时间与耗时。点答案里的 [n] 可跳到证据抽屉核对原文。"
									: library?.status === "empty"
										? "先去文库收录几份资料，问答才有据可依。"
										: libsError
											? "请先恢复 API 连接后再提问。"
											: "索引完成前暂不可提问，可先到文库查看进度。"}
							</p>
							{!canAsk ? (
								<Link
									href="/app/libraries"
									className={cn(
										buttonVariants({ variant: "outline" }),
										"desk-enter desk-enter-delay-2 w-fit rounded-md",
									)}
								>
									前往文库
									<ChevronRight data-icon="inline-end" />
								</Link>
							) : (
								<div className="desk-enter desk-enter-delay-2 flex flex-wrap gap-2">
									{[
										"林仁杰的教育背景是什么？",
										"DustyKB 用了哪些技术栈？",
										"毕业设计说明书的题目和作者是谁？",
									].map((sample) => (
										<button
											key={sample}
											type="button"
											onClick={() => setInput(sample)}
											className="rounded-md border border-border/80 bg-card/80 px-3 py-2 text-left text-xs leading-5 text-muted-foreground transition-all hover:-translate-y-0.5 hover:border-cite/35 hover:text-foreground hover:shadow-sm"
										>
											{sample}
										</button>
									))}
								</div>
							)}
						</div>
					) : (
						<ul className="mx-auto flex max-w-2xl flex-col gap-6">
							{turns.map((turn, turnIndex) => (
								<li
									key={turn.id}
									className="desk-enter space-y-3"
									style={{ animationDelay: `${Math.min(turnIndex, 4) * 40}ms` }}
								>
									<div className="rounded-md border border-border/70 bg-secondary/45 px-4 py-3 transition-colors">
										<div className="flex flex-wrap items-center justify-between gap-2">
											<p className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
												Question
											</p>
											{turn.startedAt ? (
												<span className="meta-chip">
													{formatDateTime(turn.startedAt)}
												</span>
											) : null}
										</div>
										<p className="mt-1 text-sm leading-6 text-foreground">
											{turn.question}
										</p>
									</div>
									<div className="rounded-md border border-border/80 bg-card/95 px-4 py-4 shadow-sm transition-shadow hover:shadow-md">
										<div className="flex flex-wrap items-center justify-between gap-2">
											<p className="font-mono text-[10px] tracking-[0.14em] text-cite uppercase">
												{turn.refused ? "Refused" : "Answer"}
												{turn.mode ? ` · ${turn.mode}` : ""}
											</p>
											<div className="flex flex-wrap gap-1.5">
												{turn.pending ? (
													<span className="meta-chip animate-pulse text-cite">
														处理中…
													</span>
												) : null}
												{turn.durationMs != null ? (
													<span className="meta-chip text-foreground/80">
														总耗时 {formatDurationMs(turn.durationMs)}
													</span>
												) : null}
												{turn.evidenceMs != null ? (
													<span className="meta-chip">
														检索 {formatDurationMs(turn.evidenceMs)}
													</span>
												) : null}
												{turn.retrievalMode || turn.usedHybrid ? (
													<span className="meta-chip">
														{turn.usedHybrid
															? "hybrid"
															: turn.retrievalMode || "dense"}
													</span>
												) : null}
												{typeof turn.topScore === "number" ? (
													<span className="meta-chip">
														top {formatScore(turn.topScore)}
													</span>
												) : null}
												{turn.citations.length > 0 ? (
													<span className="meta-chip">
														{turn.citations.length} 证据
													</span>
												) : null}
											</div>
										</div>
										{turn.pending && !turn.answer && !turn.evidenceReady ? (
											<p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
												<span className="inline-block size-1.5 animate-pulse rounded-full bg-cite" />
												正在检索并整理依据…
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
												{turn.refused ? (
													<p className="mt-2 font-mono text-[11px] text-survey">
														{turn.refuseReason === "weak_match"
															? "弱相关 · 未调用生成"
															: "无命中 · 未调用生成"}
													</p>
												) : null}
												<RetrievalNotice turn={turn} />
												{turn.answer ? (
													<AnswerBody
														answer={turn.answer}
														citations={turn.citations}
														pending={turn.pending}
														onCite={openCitation}
													/>
												) : turn.pending ? (
													<p className="mt-2 text-sm text-muted-foreground">
														依据已就绪，正在生成回答…
														<span className="ml-0.5 inline-block h-4 w-1 animate-pulse bg-cite/70 align-text-bottom" />
													</p>
												) : null}
												{turn.citations.length > 0 ? (
													<div className="mt-4 space-y-2">
														<p className="font-mono text-[11px] text-muted-foreground">
															依据 {turn.citations.length} 条证据片段
															{turn.completedAt
																? ` · 完成于 ${formatDateTime(turn.completedAt)}`
																: ""}
														</p>
														<div className="flex flex-wrap gap-2">
															{turn.citations.map((citation) => {
																const sameDocCount = turn.citations.filter(
																	(item) =>
																		item.docId && item.docId === citation.docId,
																).length;
																return (
																	<button
																		key={citation.id}
																		type="button"
																		onClick={() => openCitation(citation)}
																		className={cn(
																			"max-w-full rounded-md border px-2 py-1.5 text-left transition-all",
																			activeCitation?.id === citation.id
																				? "border-cite/40 bg-cite/10 text-cite shadow-sm"
																				: "border-border bg-background text-muted-foreground hover:-translate-y-0.5 hover:border-cite/30 hover:text-foreground",
																		)}
																	>
																		<span className="font-mono text-[11px]">
																			[{citation.index}] {citation.title}
																			{citation.sectionPath
																				? ` · ${citation.sectionPath}`
																				: citation.page
																					? ` · ${citation.page}`
																					: ""}
																			{sameDocCount > 1 &&
																			citation.chunkIndex != null
																				? ` · #${citation.chunkIndex}`
																				: ""}
																		</span>
																		<span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground/90">
																			{snippetPreview(
																				citation.snippet || citation.text,
																			)}
																		</span>
																	</button>
																);
															})}
														</div>
													</div>
												) : turn.refused ? (
													<p className="mt-4 font-mono text-[11px] text-muted-foreground">
														无可用证据片段
													</p>
												) : null}
											</>
										)}
									</div>
								</li>
							))}
						</ul>
					)}
				</div>

				<form
					onSubmit={onSubmit}
					className="border-t border-border/80 bg-card/70 px-5 py-4 backdrop-blur-sm"
				>
					<div className="mx-auto flex max-w-2xl gap-3">
						<textarea
							value={input}
							onChange={(event) => setInput(event.target.value)}
							onKeyDown={onKeyDown}
							disabled={!canAsk}
							rows={2}
							placeholder={
								canAsk
									? "输入问题，Enter 发送 · Shift+Enter 换行"
									: "文库就绪后再提问…"
							}
							className="min-h-[72px] flex-1 resize-none rounded-md border border-border bg-background px-3 py-2.5 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground/80 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60"
						/>
						<Button
							type="submit"
							disabled={!canAsk || !input.trim()}
							className="h-auto self-end rounded-md px-3"
						>
							<Send data-icon="inline-start" />
							发送
						</Button>
					</div>
				</form>
			</section>

			<aside
				className={cn(
					"shrink-0 overflow-hidden border-l border-border/80 bg-card/85 backdrop-blur-sm transition-[width,opacity] duration-200",
					drawerOpen ? "w-[320px] opacity-100" : "w-0 opacity-0 border-l-0",
				)}
				aria-hidden={!drawerOpen}
			>
				<div className="flex h-full w-[320px] flex-col">
					<div className="flex h-12 items-center justify-between border-b border-border/70 px-4">
						<div>
							<p className="font-mono text-[10px] tracking-[0.16em] text-cite uppercase">
								Evidence
							</p>
							<p className="text-sm font-medium text-foreground">证据片段</p>
						</div>
						<button
							type="button"
							onClick={() => setDrawerOpen(false)}
							className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
							aria-label="关闭证据抽屉"
						>
							<PanelRightClose className="size-4" />
						</button>
					</div>
					<div className="flex-1 overflow-y-auto p-4">
						{activeCitation ? (
							<article className="desk-enter cite-rail space-y-3 rounded-md bg-background/80 py-3 pr-3">
								<p className="font-mono text-[11px] text-cite">
									[{activeCitation.index}] · {activeCitation.title}
									{activeCitation.page ? ` · ${activeCitation.page}` : ""}
								</p>
								<div className="flex flex-wrap gap-1.5">
									<span className="meta-chip">
										score {formatScore(activeCitation.score)}
									</span>
									{activeCitation.sectionPath ? (
										<span className="meta-chip">
											{activeCitation.sectionPath}
										</span>
									) : null}
									{evidenceText ? (
										<span className="meta-chip">{evidenceText.length} 字</span>
									) : null}
								</div>
								{activeCitation.preamble ? (
									<p className="rounded-md border border-border/60 bg-card/50 px-2 py-1.5 text-[11px] leading-5 text-muted-foreground">
										定位 {activeCitation.preamble}
									</p>
								) : null}
								{activeCitation.filename ? (
									<p className="font-mono text-[10px] text-muted-foreground">
										文件 {activeCitation.filename}
										{activeCitation.chunkIndex != null
											? ` · chunk ${activeCitation.chunkIndex}`
											: ""}
									</p>
								) : null}
								<div className="max-h-[50vh] overflow-y-auto rounded-md border border-border/60 bg-card/50 px-2.5 py-2">
									<p className="whitespace-pre-wrap text-sm leading-6 text-foreground/90">
										{evidenceText}
									</p>
								</div>
							</article>
						) : (
							<div className="desk-enter space-y-2 text-sm leading-6 text-muted-foreground">
								<p>
									这里展示本轮检索命中的原文片段。点答案里的 [n]
									或下方证据块即可核对。
								</p>
								<p className="font-mono text-[10px] text-muted-foreground/80">
									提示：证据抽屉可随时用顶栏「证据」开关
								</p>
							</div>
						)}
					</div>
				</div>
			</aside>
		</div>
	);
}
