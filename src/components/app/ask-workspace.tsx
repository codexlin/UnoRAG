"use client";

import { ChevronRight, PanelRightOpen } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
	type FormEvent,
	type KeyboardEvent,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";
import { AskComposer } from "@/components/app/ask-composer";
import { AskConversationList } from "@/components/app/ask-conversation-list";
import { AskSourcesPanel } from "@/components/app/ask-sources-panel";
import {
	AskTraceDrawer,
	stageDurationMs,
} from "@/components/app/ask-trace-drawer";
import {
	askTurnsReducer,
	completedTurn,
	type LocalTurn,
	toApiCitation,
	toUiCitation,
} from "@/components/app/ask-turn-state";
import { AskWorkspaceHeader } from "@/components/app/ask-workspace-header";
import { buttonVariants } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { useDocuments } from "@/hooks/use-documents";
import { useHealth } from "@/hooks/use-health";
import { useLibraries } from "@/hooks/use-libraries";
import { useIsMobile } from "@/hooks/use-mobile";
import {
	type ApiDocument,
	type ApiRetrievalDebug,
	archiveThread,
	askQuestionStream,
	continueThread,
	isAbortError,
} from "@/lib/api";
import {
	ASK_LIBRARY_STORAGE_KEY,
	chooseAskLibraryId,
	isAskableLibrary,
} from "@/lib/ask-library-selection.mjs";
import type { UiCitation } from "@/lib/ui-types";
import { cn } from "@/lib/utils";

/** 中性示例：不暗示内置语料，仅在无可用文档标题时使用 */
const NEUTRAL_SAMPLE_QUESTIONS = [
	"这份资料的主要内容是什么？",
	"有哪些关键要点值得注意？",
] as const;

const DOC_QUESTION_TEMPLATES = [
	(title: string) => `《${title}》里说了什么？`,
	(title: string) => `关于「${title}」的要点是什么？`,
	(title: string) => `总结一下《${title}》的核心内容`,
] as const;

function documentDisplayTitle(doc: ApiDocument): string {
	const raw = (doc.name || doc.filename || "").trim();
	if (!raw) return "";
	return raw.replace(/\.[A-Za-z0-9]{1,8}$/, "").trim() || raw;
}

/** 根据就绪文档标题生成 2～3 条可点提问；无标题时退回中性文案 */
function buildSampleQuestions(docs: ApiDocument[]): string[] {
	const titles = docs
		.filter((doc) => doc.status === "ready")
		.map(documentDisplayTitle)
		.filter(Boolean);
	const unique: string[] = [];
	for (const title of titles) {
		if (!unique.includes(title)) unique.push(title);
		if (unique.length >= 3) break;
	}
	if (unique.length === 0) {
		return [...NEUTRAL_SAMPLE_QUESTIONS];
	}
	return unique.map((title, index) =>
		DOC_QUESTION_TEMPLATES[index % DOC_QUESTION_TEMPLATES.length](title),
	);
}

function canRetryTurn(turn: LocalTurn): boolean {
	if (turn.pending) return false;
	return Boolean(turn.error || turn.cancelled || turn.refused);
}

export function AskWorkspace() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const isMobile = useIsMobile();
	const reduceMotion = useReducedMotion();
	const {
		libraries,
		error: libsError,
		loading: librariesLoading,
	} = useLibraries();
	const { apiReady, loading: healthLoading } = useHealth();
	const [libraryId, setLibraryId] = useState("");
	const [input, setInput] = useState("");
	const [sessionId, setSessionId] = useState<string | undefined>();
	const [threadId, setThreadId] = useState<string | undefined>();
	const [threadTitle, setThreadTitle] = useState<string | null>(null);
	const [archiving, setArchiving] = useState(false);
	const [archiveError, setArchiveError] = useState<string | null>(null);
	const [resumeLibraryMissing, setResumeLibraryMissing] = useState<
		string | null
	>(null);
	const [turns, dispatchTurns] = useReducer(askTurnsReducer, []);
	const [activeCitation, setActiveCitation] = useState<UiCitation | null>(null);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [traceDebug, setTraceDebug] = useState<ApiRetrievalDebug | null>(null);
	const [traceClientMs, setTraceClientMs] = useState<number | null>(null);
	const [traceOpen, setTraceOpen] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const abortRef = useRef<AbortController | null>(null);
	const activeTurnIdRef = useRef<string | null>(null);
	const resumeThreadRef = useRef<string | null>(null);
	const {
		documents: libraryDocuments,
		fetched: documentsFetched,
		error: documentsError,
	} = useDocuments(libraryId, { enabled: Boolean(libraryId && apiReady) });
	const readyDocuments = useMemo(
		() => libraryDocuments.filter((doc) => doc.status === "ready"),
		[libraryDocuments],
	);
	const docsLoaded = Boolean(
		libraryId && apiReady && (documentsFetched || documentsError),
	);

	const isStreaming = turns.some((turn) => turn.pending);
	const isArchived = Boolean(threadId);
	const canArchive =
		!isArchived &&
		!isStreaming &&
		!archiving &&
		turns.some((turn) => !turn.pending && turn.question.trim());

	useEffect(() => {
		if (librariesLoading) return;
		if (resumeLibraryMissing) return;
		if (libraries.length === 0) {
			setLibraryId("");
			try {
				window.localStorage.removeItem(ASK_LIBRARY_STORAGE_KEY);
			} catch {
				// Storage may be unavailable in hardened/private browser contexts.
			}
			return;
		}

		let storedId = "";
		try {
			storedId =
				window.localStorage.getItem(ASK_LIBRARY_STORAGE_KEY)?.trim() ?? "";
		} catch {
			// Continue with the deterministic ready-library fallback.
		}
		const nextId = chooseAskLibraryId(libraries, libraryId || storedId);
		if (nextId !== libraryId) {
			setLibraryId(nextId);
			return;
		}
		if (nextId) {
			try {
				window.localStorage.setItem(ASK_LIBRARY_STORAGE_KEY, nextId);
			} catch {
				// Selection still works when persistence is unavailable.
			}
		}
	}, [libraries, librariesLoading, libraryId, resumeLibraryMissing]);

	useEffect(() => {
		return () => {
			abortRef.current?.abort();
		};
	}, []);

	useEffect(() => {
		const resumeId = (searchParams.get("thread") || "").trim();
		if (!resumeId || resumeThreadRef.current === resumeId) return;
		if (!apiReady) return;
		if (librariesLoading) return;
		resumeThreadRef.current = resumeId;
		const controller = new AbortController();
		void (async () => {
			try {
				const detail = await continueThread(resumeId, controller.signal);
				if (controller.signal.aborted) return;
				setThreadId(detail.id);
				setThreadTitle(detail.title);
				setSessionId(detail.session_id || detail.id);
				const archivedLibraryId = (detail.library_id || "").trim();
				if (
					archivedLibraryId &&
					!libraries.some((item) => item.id === archivedLibraryId)
				) {
					setResumeLibraryMissing(archivedLibraryId);
					setLibraryId("");
				} else {
					setResumeLibraryMissing(null);
					if (archivedLibraryId) setLibraryId(archivedLibraryId);
				}
				dispatchTurns({
					type: "hydrate",
					turns: detail.turns.map((turn, index) => ({
						id: turn.id || `resume-${index}`,
						question: turn.question,
						answer: turn.answer,
						citations: turn.citations.map(toUiCitation),
						refused: turn.refused,
						refuseReason: turn.refuse_reason,
						mode: turn.mode,
						pending: false,
						persisted: true,
						retrievalDebug: turn.retrieval_debug || undefined,
					})),
				});
				setArchiveError(null);
			} catch (err) {
				if (controller.signal.aborted || isAbortError(err)) return;
				setArchiveError("无法打开归档会话，请从会话历史重试。");
			}
		})();
		return () => controller.abort();
	}, [apiReady, libraries, librariesLoading, searchParams]);

	function resizeComposer(
		el: HTMLTextAreaElement | null = textareaRef.current,
	) {
		if (!el) return;
		el.style.height = "0px";
		el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
	}

	const library = useMemo(
		() => libraries.find((item) => item.id === libraryId) ?? null,
		[libraries, libraryId],
	);

	const canAsk = Boolean(isAskableLibrary(library) && apiReady);

	const sampleQuestions = useMemo(() => {
		if (!canAsk || !docsLoaded) return [];
		return buildSampleQuestions(readyDocuments);
	}, [canAsk, docsLoaded, readyDocuments]);

	const hasReadyDocTitles = useMemo(
		() => readyDocuments.some((doc) => Boolean(documentDisplayTitle(doc))),
		[readyDocuments],
	);

	function openCitation(citation: UiCitation) {
		setTraceOpen(false);
		setActiveCitation(citation);
		setDrawerOpen(true);
	}

	function openTrace(
		debug: ApiRetrievalDebug,
		clientDurationMs?: number | null,
	) {
		setDrawerOpen(false);
		setTraceDebug(debug);
		setTraceClientMs(
			clientDurationMs != null && !Number.isNaN(clientDurationMs)
				? clientDurationMs
				: null,
		);
		setTraceOpen(true);
	}

	function cancelAsk() {
		abortRef.current?.abort();
	}

	async function handleArchive() {
		if (!canArchive) return;
		const readyTurns = turns.filter(
			(turn) => !turn.pending && turn.question.trim() && !turn.error,
		);
		if (readyTurns.length === 0) return;
		setArchiving(true);
		setArchiveError(null);
		try {
			const detail = await archiveThread({
				sessionId,
				libraryId: libraryId || undefined,
				title: readyTurns[0]?.question?.slice(0, 80),
				turns: readyTurns.map((turn) => ({
					question: turn.question,
					answer: turn.answer,
					citations: turn.citations.map(toApiCitation),
					mode: turn.mode || "stub",
					refused: Boolean(turn.refused),
					refuse_reason: turn.refuseReason,
					library_id: libraryId || undefined,
				})),
			});
			setThreadId(detail.id);
			setThreadTitle(detail.title);
			setSessionId(detail.session_id || detail.id);
			router.replace(`/app/ask?thread=${encodeURIComponent(detail.id)}`);
		} catch (err) {
			setArchiveError(
				err instanceof Error ? err.message : "归档失败，请稍后重试",
			);
		} finally {
			setArchiving(false);
		}
	}

	async function submitQuestion(
		question: string,
		options?: { replaceTurnId?: string },
	) {
		const trimmed = question.trim();
		if (!trimmed || !canAsk || !libraryId) return;
		if (isStreaming && !options?.replaceTurnId) return;

		const replaceTurnId = options?.replaceTurnId;
		if (replaceTurnId && isStreaming) {
			cancelAsk();
		}

		const pendingId = replaceTurnId ?? `pending-${Date.now()}`;
		const startedAtMs = performance.now();
		const startedAt = Date.now();

		const controller = new AbortController();
		abortRef.current?.abort();
		abortRef.current = controller;
		activeTurnIdRef.current = pendingId;

		dispatchTurns({
			type: "begin",
			replaceTurnId,
			turn: {
				id: pendingId,
				question: trimmed,
				answer: "",
				citations: [],
				pending: true,
				evidenceReady: false,
				startedAtMs,
				startedAt,
			},
		});
		if (!replaceTurnId) {
			setInput("");
			requestAnimationFrame(() => resizeComposer());
		}
		setTraceOpen(false);
		setDrawerOpen(true);

		try {
			await askQuestionStream(
				{
					question: trimmed,
					libraryId,
					sessionId,
					threadId,
				},
				{
					onMeta: (meta) => {
						if (activeTurnIdRef.current !== pendingId) return;
						setSessionId(meta.session_id);
						if (meta.thread_id) setThreadId(meta.thread_id);
						dispatchTurns({
							type: "meta",
							turnId: pendingId,
							patch: {
								refused: meta.refused,
								refuseReason: meta.refuse_reason,
								mode: meta.mode,
								hybridFailed: Boolean(meta.hybrid_failed),
								rerankFailed: Boolean(meta.rerank_failed),
								retrievalMode: meta.retrieval_mode,
							},
						});
					},
					onCitations: (citations) => {
						if (activeTurnIdRef.current !== pendingId) return;
						const mapped = citations.map(toUiCitation);
						const evidenceMs = Math.round(performance.now() - startedAtMs);
						dispatchTurns({
							type: "citations",
							turnId: pendingId,
							citations: mapped,
							evidenceMs,
						});
						setActiveCitation(mapped[0] ?? null);
					},
					onToken: (token) => {
						if (activeTurnIdRef.current !== pendingId) return;
						dispatchTurns({ type: "token", turnId: pendingId, token });
					},
					onDone: (result) => {
						if (activeTurnIdRef.current !== pendingId) return;
						setSessionId(result.session_id);
						if (result.thread_id) setThreadId(result.thread_id);
						const citations = result.citations.map(toUiCitation);
						const debug: ApiRetrievalDebug = result.retrieval_debug || {};
						const completedAt = Date.now();
						const durationMs = Math.round(performance.now() - startedAtMs);
						const retrieveMs = stageDurationMs(debug, "retrieve");
						dispatchTurns({
							type: "complete",
							turnId: pendingId,
							turn: completedTurn({
								id: `turn-${completedAt}`,
								question: trimmed,
								answer: result.answer,
								citations,
								refused: result.refused,
								refuseReason: result.refuse_reason,
								mode: result.mode,
								startedAt,
								completedAt,
								durationMs,
								retrieveMs: retrieveMs ?? undefined,
								debug,
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
								persisted: result.persisted === true,
								persistError: result.persist_error,
							}),
						});
						setActiveCitation(citations[0] ?? null);
					},
					onError: (message) => {
						throw new Error(message);
					},
				},
				controller.signal,
			);
		} catch (err) {
			const completedAt = Date.now();
			const durationMs = Math.round(performance.now() - startedAtMs);
			const aborted = controller.signal.aborted || isAbortError(err);

			if (aborted) {
				dispatchTurns({
					type: "terminal",
					turnId: pendingId,
					completedAt,
					durationMs,
					cancelled: true,
				});
				return;
			}

			const message =
				err instanceof Error ? err.message : "请求失败，请确认 API 已启动";
			dispatchTurns({
				type: "terminal",
				turnId: pendingId,
				completedAt,
				durationMs,
				cancelled: false,
				error: message,
			});
		} finally {
			if (abortRef.current === controller) {
				abortRef.current = null;
			}
			if (activeTurnIdRef.current === pendingId) {
				activeTurnIdRef.current = null;
			}
		}
	}

	function retryTurn(turn: LocalTurn) {
		if (!canRetryTurn(turn) || !canAsk) return;
		void submitQuestion(turn.question, { replaceTurnId: turn.id });
	}

	function onSubmit(event: FormEvent) {
		event.preventDefault();
		if (isStreaming) {
			cancelAsk();
			return;
		}
		void submitQuestion(input);
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			if (isStreaming) return;
			void submitQuestion(input);
		}
	}

	return (
		<div className="flex min-h-0 flex-1">
			<section className="flex min-w-0 flex-1 flex-col">
				<AskWorkspaceHeader
					archiving={archiving}
					canArchive={canArchive}
					drawerOpen={drawerOpen}
					isArchived={isArchived}
					libraries={libraries}
					library={library}
					libraryId={libraryId}
					onArchive={() => void handleArchive()}
					onDrawerOpenChange={(open) => {
						if (open) setTraceOpen(false);
						setDrawerOpen(open);
					}}
					onLibraryChange={(nextId) => {
						setResumeLibraryMissing(null);
						setLibraryId(nextId);
					}}
					threadTitle={threadTitle}
					turnCount={turns.length}
				/>
				{libsError ? (
					<p className="border-b border-destructive/30 bg-destructive/10 px-5 py-1.5 text-sm text-destructive">
						{libsError}
					</p>
				) : null}
				{archiveError ? (
					<p className="border-b border-destructive/30 bg-destructive/10 px-5 py-1.5 text-sm text-destructive">
						{archiveError}
					</p>
				) : null}
				{resumeLibraryMissing ? (
					<p className="border-b border-survey/35 bg-accent px-5 py-2 text-sm text-accent-foreground">
						原知识库已删除，历史回答与引用快照仍可回放。请从上方明确选择一个已就绪的知识库后继续对话。
					</p>
				) : null}

				<ScrollArea className="min-h-0 flex-1">
					<div className="px-5 py-6">
						{turns.length === 0 ? (
							<div className="desk-enter mx-auto flex max-w-xl flex-col gap-5 py-10">
								<p className="text-meta font-mono tracking-[0.14em] text-cite">
									{healthLoading
										? "服务状态 · 探测中"
										: !apiReady
											? "服务状态 · 暂不可用"
											: library
												? `知识库 · ${library.name}${
														library.status === "empty"
															? " · 空"
															: library.status === "indexing"
																? " · 索引中"
																: ""
													}`
												: libraries.length === 0
													? "知识库 · 尚未创建"
													: "知识库 · 请选择"}
								</p>
								<h2 className="font-heading text-2xl font-semibold tracking-tight text-foreground">
									{canAsk
										? "向知识库提问，答案可追溯到原文"
										: healthLoading
											? "正在检查服务状态"
											: !apiReady
												? "服务暂不可用"
												: !library
													? libraries.length === 0
														? "还没有知识库"
														: "请选择知识库"
													: library.status === "empty"
														? "知识库还是空的"
														: library.status === "failed"
															? "文档处理失败"
															: "文档仍在索引中"}
								</h2>
								<p className="text-answer desk-enter desk-enter-delay-1 text-muted-foreground">
									{canAsk
										? "支持流式回答与来源核对。点击答案中的引用编号，即可沿证据轨道回到原文。"
										: healthLoading
											? "正在连接知识库服务，请稍候。"
											: !apiReady || libsError
												? "请先恢复 API 连接后再提问。"
												: !library
													? libraries.length === 0
														? "先到「知识库」创建空间并上传文档。"
														: "从上方选择一个已就绪的知识库。"
													: library.status === "empty"
														? "先上传文档完成索引，再回来提问。"
														: library.status === "failed"
															? "当前没有可检索文档，请到知识库查看失败原因并重试。"
															: "索引完成后即可提问，可先到知识库查看进度。"}
								</p>
								{!canAsk ? (
									<Link
										href="/app/libraries"
										className={cn(
											buttonVariants({ variant: "outline" }),
											"desk-enter desk-enter-delay-2 w-fit rounded-lg",
										)}
									>
										{libraries.length === 0
											? "去创建知识库"
											: library?.status === "empty" || library?.doc_count === 0
												? "去上传文档"
												: "前往知识库"}
										<ChevronRight data-icon="inline-end" />
									</Link>
								) : docsLoaded ? (
									<div className="desk-enter desk-enter-delay-2 space-y-2">
										{!hasReadyDocTitles ? (
											<p className="text-xs text-muted-foreground">
												先上传文档后再提问，或试试下面的通用问法。
											</p>
										) : null}
										<div className="flex flex-wrap gap-2">
											{sampleQuestions.map((sample) => (
												<button
													key={sample}
													type="button"
													onClick={() => setInput(sample)}
													className="rounded-md border border-border/80 bg-card px-3.5 py-2 text-left text-xs leading-5 text-muted-foreground transition-colors hover:border-cite/40 hover:bg-cite/5 hover:text-foreground"
												>
													{sample}
												</button>
											))}
										</div>
									</div>
								) : null}
							</div>
						) : (
							<AskConversationList
								activeCitation={activeCitation}
								canAsk={canAsk}
								isStreaming={isStreaming}
								onCancel={cancelAsk}
								onOpenCitation={openCitation}
								onOpenTrace={openTrace}
								onRetry={retryTurn}
								reduceMotion={reduceMotion}
								turns={turns}
							/>
						)}
					</div>
				</ScrollArea>

				<AskComposer
					canAsk={canAsk}
					healthLoading={healthLoading}
					input={input}
					isStreaming={isStreaming}
					onCancel={cancelAsk}
					onChange={(value, element) => {
						setInput(value);
						resizeComposer(element);
					}}
					onKeyDown={onKeyDown}
					onSubmit={onSubmit}
					textareaRef={textareaRef}
				/>
			</section>

			{!isMobile && !drawerOpen ? (
				<button
					type="button"
					onClick={() => {
						setTraceOpen(false);
						setDrawerOpen(true);
					}}
					className="group hidden w-7 shrink-0 flex-col items-center justify-center gap-2 border-l border-cite/25 bg-cite/[0.06] text-cite transition-colors hover:bg-cite/12 md:flex"
					aria-label="展开引用来源面板"
					title="展开引用来源"
				>
					<PanelRightOpen className="size-4 shrink-0" aria-hidden />
					<span
						className="text-meta font-mono tracking-[0.18em] uppercase [writing-mode:vertical-rl]"
						aria-hidden
					>
						Evidence
					</span>
				</button>
			) : null}

			{isMobile ? (
				<Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
					<SheetContent
						side="right"
						showCloseButton={false}
						className="p-0 data-[side=right]:w-[min(92vw,384px)] data-[side=right]:sm:max-w-96"
					>
						<SheetHeader className="sr-only">
							<SheetTitle>证据轨道</SheetTitle>
							<SheetDescription>
								查看回答所依据的完整原文、文档位置与检索诊断
							</SheetDescription>
						</SheetHeader>
						<AskSourcesPanel
							activeCitation={activeCitation}
							onClose={() => setDrawerOpen(false)}
						/>
					</SheetContent>
				</Sheet>
			) : (
				<motion.aside
					className={cn(
						"hidden shrink-0 overflow-hidden border-l border-border/80 bg-card md:block",
						!drawerOpen && "border-l-0",
					)}
					initial={false}
					animate={{
						width: drawerOpen ? 384 : 0,
						opacity: drawerOpen ? 1 : 0,
					}}
					transition={
						reduceMotion
							? { duration: 0 }
							: { duration: 0.22, ease: [0.22, 1, 0.36, 1] }
					}
					aria-hidden={!drawerOpen}
				>
					<div className="h-full w-96">
						<AskSourcesPanel
							activeCitation={activeCitation}
							onClose={() => setDrawerOpen(false)}
						/>
					</div>
				</motion.aside>
			)}

			<AskTraceDrawer
				open={traceOpen}
				onOpenChange={(open) => {
					setTraceOpen(open);
					if (!open) setTraceClientMs(null);
				}}
				debug={traceDebug}
				clientDurationMs={traceClientMs}
			/>
		</div>
	);
}
