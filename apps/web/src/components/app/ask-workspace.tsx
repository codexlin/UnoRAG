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
};

function toUiCitation(citation: ApiCitation): UiCitation {
	const text = citation.text || citation.snippet || "";
	return {
		id: citation.id,
		index: citation.index,
		title: citation.title,
		page: citation.page ?? undefined,
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
		setTurns((prev) => [
			...prev,
			{
				id: pendingId,
				question: trimmed,
				answer: "",
				citations: [],
				pending: true,
				evidenceReady: false,
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
						setTurns((prev) =>
							prev.map((turn) =>
								turn.id === pendingId
									? {
											...turn,
											citations: mapped,
											evidenceReady: true,
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
					<div className="flex items-center gap-2">
						<span className="font-mono text-[11px] text-muted-foreground">
							{library
								? `${library.ready_count}/${library.doc_count} 就绪`
								: "未选择"}
						</span>
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="rounded-md"
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
						<div className="mx-auto flex max-w-xl flex-col gap-4 py-10">
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
							<p className="text-sm leading-6 text-muted-foreground">
								{canAsk
									? "流式回答会边生成边显示；下方证据块可点开核对原文。点答案里的 [n] 也能跳到对应片段。"
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
										"w-fit rounded-md",
									)}
								>
									前往文库
									<ChevronRight data-icon="inline-end" />
								</Link>
							) : (
								<div className="flex flex-wrap gap-2">
									{[
										"病假需要在几天内补交证明？",
										"试用期考核通过标准是什么？",
									].map((sample) => (
										<button
											key={sample}
											type="button"
											onClick={() => setInput(sample)}
											className="rounded-md border border-border/80 bg-card/80 px-3 py-2 text-left text-xs leading-5 text-muted-foreground transition-colors hover:border-border hover:text-foreground"
										>
											{sample}
										</button>
									))}
								</div>
							)}
						</div>
					) : (
						<ul className="mx-auto flex max-w-2xl flex-col gap-6">
							{turns.map((turn) => (
								<li key={turn.id} className="space-y-3">
									<div className="rounded-md border border-border/70 bg-secondary/40 px-4 py-3">
										<p className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
											Question
										</p>
										<p className="mt-1 text-sm leading-6 text-foreground">
											{turn.question}
										</p>
									</div>
									<div className="rounded-md border border-border/80 bg-card/90 px-4 py-4 shadow-sm">
										<p className="font-mono text-[10px] tracking-[0.14em] text-cite uppercase">
											{turn.refused ? "Refused" : "Answer"}
											{turn.mode ? ` · ${turn.mode}` : ""}
										</p>
										{turn.pending && !turn.answer && !turn.evidenceReady ? (
											<p className="mt-2 text-sm text-muted-foreground">
												正在检索并整理依据…
											</p>
										) : turn.error ? (
											<p className="mt-2 text-sm text-destructive">
												{turn.error}
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
															{typeof turn.topScore === "number"
																? ` · top ${turn.topScore.toFixed(2)}`
																: ""}
															{turn.usedHybrid
																? " · hybrid"
																: turn.retrievalMode
																	? ` · ${turn.retrievalMode}`
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
																			"max-w-full rounded-md border px-2 py-1.5 text-left transition-colors",
																			activeCitation?.id === citation.id
																				? "border-cite/40 bg-cite/10 text-cite"
																				: "border-border bg-background text-muted-foreground hover:text-foreground",
																		)}
																	>
																		<span className="font-mono text-[11px]">
																			[{citation.index}] {citation.title}
																			{sameDocCount > 1 &&
																			citation.chunkIndex != null
																				? ` · 第 ${citation.chunkIndex + 1} 段`
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
							<article className="cite-rail space-y-3 rounded-md bg-background/70 py-3 pr-3">
								<p className="font-mono text-[11px] text-cite">
									[{activeCitation.index}] · {activeCitation.title}
									{activeCitation.page ? ` · ${activeCitation.page}` : ""}
								</p>
								{activeCitation.filename ? (
									<p className="font-mono text-[10px] text-muted-foreground">
										文件 {activeCitation.filename}
										{activeCitation.chunkIndex != null
											? ` · chunk ${activeCitation.chunkIndex}`
											: ""}
									</p>
								) : null}
								<div className="max-h-[50vh] overflow-y-auto rounded-md border border-border/60 bg-card/40 px-2.5 py-2">
									<p className="whitespace-pre-wrap text-sm leading-6 text-foreground/90">
										{evidenceText}
									</p>
								</div>
								<p className="font-mono text-[11px] text-muted-foreground">
									score {activeCitation.score.toFixed(2)}
									{evidenceText.length > (activeCitation.snippet?.length || 0)
										? ` · 全文 ${evidenceText.length} 字`
										: ""}
								</p>
							</article>
						) : (
							<p className="text-sm leading-6 text-muted-foreground">
								这里展示本轮检索命中的原文片段（不是导航标签）。点答案里的 [n]
								或下方证据块即可核对。
							</p>
						)}
					</div>
				</div>
			</aside>
		</div>
	);
}
