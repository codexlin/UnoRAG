"use client";

import { ChevronRight } from "lucide-react";
import { useReducedMotion } from "motion/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
	type FormEvent,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { AskComposer } from "@/components/app/ask/ask-composer";
import { AskConversationList } from "@/components/app/ask/ask-conversation-list";
import { AskSourcesPanel } from "@/components/app/ask/ask-sources-panel";
import { createAskStreamLifecycle } from "@/components/app/ask/ask-stream-lifecycle";
import {
	AskTraceDrawer,
	stageDurationMs,
} from "@/components/app/ask/ask-trace-drawer";
import {
	askTurnsReducer,
	completedTurn,
	type LocalTurn,
	toApiCitation,
	toUiCitation,
} from "@/components/app/ask/ask-turn-state";
import { AskWorkspaceHeader } from "@/components/app/ask/ask-workspace-header";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerProvider,
	MessageScrollerViewport,
} from "@/components/ui/message-scroller";
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
import { createClientId } from "@/lib/client-id";
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

const subscribeToHydration = () => () => undefined;

const WIDE_SOURCES_QUERY = "(min-width: 1280px)";
function subscribeWideSources(listener: () => void) {
	const media = window.matchMedia(WIDE_SOURCES_QUERY);
	media.addEventListener("change", listener);
	return () => media.removeEventListener("change", listener);
}
function getWideSourcesSnapshot() {
	return window.matchMedia(WIDE_SOURCES_QUERY).matches;
}
const getServerWideSourcesSnapshot = () => false;

export function AskWorkspace() {
	const mounted = useSyncExternalStore(
		subscribeToHydration,
		() => true,
		() => false,
	);
	// Parent queries can populate the cache before this Suspense boundary hydrates.
	if (!mounted) {
		return (
			<div
				role="status"
				className="flex flex-1 items-center justify-center text-sm text-muted-foreground"
			>
				加载问答…
			</div>
		);
	}
	return <AskWorkspaceContent />;
}

function AskWorkspaceContent() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const requestedThreadId = (searchParams.get("thread") || "").trim();
	const wideSources = useSyncExternalStore(
		subscribeWideSources,
		getWideSourcesSnapshot,
		getServerWideSourcesSnapshot,
	);
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
	const archivingRef = useRef(false);
	const [archiveError, setArchiveError] = useState<string | null>(null);
	const [resumeLibraryMissing, setResumeLibraryMissing] = useState<
		string | null
	>(null);
	const [turns, dispatchTurns] = useReducer(askTurnsReducer, []);
	const contextEpochRef = useRef(0);
	const [activeSource, setActiveSource] = useState<{
		turnId: string;
		citation: UiCitation;
		selectedByUser: boolean;
	} | null>(null);
	const activeCitation = activeSource?.citation ?? null;
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [traceDebug, setTraceDebug] = useState<ApiRetrievalDebug | null>(null);
	const [traceClientMs, setTraceClientMs] = useState<number | null>(null);
	const [traceOpen, setTraceOpen] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const sourceTriggerRef = useRef<HTMLElement | null>(null);
	const sourceFocusKeyRef = useRef<{ turnId: string; sourceId: string } | null>(
		null,
	);
	const [askStream] = useState(() =>
		createAskStreamLifecycle(askQuestionStream),
	);
	const resumeThreadRef = useRef<string | null>(null);
	const previousContextRef = useRef({ libraryId, requestedThreadId });
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

	const resetConversation = useCallback(() => {
		contextEpochRef.current += 1;
		askStream.cancel(false);
		resumeThreadRef.current = null;
		setThreadId(undefined);
		setThreadTitle(null);
		setSessionId(undefined);
		setInput("");
		dispatchTurns({ type: "hydrate", turns: [] });
		setActiveSource(null);
		sourceTriggerRef.current = null;
		sourceFocusKeyRef.current = null;
		setDrawerOpen(false);
		setTraceOpen(false);
		setArchiveError(null);
		setArchiving(false);
		archivingRef.current = false;
		setResumeLibraryMissing(null);
	}, [askStream]);

	useLayoutEffect(
		() => () => {
			contextEpochRef.current += 1;
			askStream.cancel(false);
		},
		[askStream],
	);

	useLayoutEffect(() => {
		const previous = previousContextRef.current;
		if (
			previous.libraryId === libraryId &&
			previous.requestedThreadId === requestedThreadId
		)
			return;
		contextEpochRef.current += 1;
		askStream.cancel();
		if (
			!requestedThreadId &&
			(previous.requestedThreadId ||
				(previous.libraryId && previous.libraryId !== libraryId))
		) {
			resetConversation();
		}
		previousContextRef.current = { libraryId, requestedThreadId };
	}, [askStream, libraryId, requestedThreadId, resetConversation]);

	useEffect(() => {
		const resumeId = requestedThreadId;
		if (!resumeId || resumeThreadRef.current === resumeId) return;
		if (!apiReady) return;
		if (librariesLoading) return;
		const controller = new AbortController();
		void (async () => {
			try {
				const detail = await continueThread(resumeId, controller.signal);
				if (controller.signal.aborted) return;
				askStream.cancel();
				resumeThreadRef.current = resumeId;
				setActiveSource(null);
				sourceFocusKeyRef.current = null;
				sourceTriggerRef.current = null;
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
			} finally {
				if (!controller.signal.aborted) {
					archivingRef.current = false;
					setArchiving(false);
				}
			}
		})();
		return () => controller.abort();
	}, [apiReady, askStream, libraries, librariesLoading, requestedThreadId]);

	useLayoutEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		if (input) el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
	}, [input]);

	const library = useMemo(
		() => libraries.find((item) => item.id === libraryId) ?? null,
		[libraries, libraryId],
	);

	const canAsk = Boolean(
		isAskableLibrary(library) &&
			apiReady &&
			!archiving &&
			(!requestedThreadId ||
				(threadId === requestedThreadId &&
					resumeThreadRef.current === requestedThreadId)),
	);

	const sampleQuestions = useMemo(() => {
		if (!canAsk || !docsLoaded) return [];
		return buildSampleQuestions(readyDocuments);
	}, [canAsk, docsLoaded, readyDocuments]);

	const openCitation = useCallback((citation: UiCitation, turnId: string) => {
		const target = document.activeElement;
		sourceTriggerRef.current =
			target instanceof HTMLElement &&
			target.dataset.citationId === citation.id &&
			target.closest<HTMLElement>("[data-turn-id]")?.dataset.turnId === turnId
				? target
				: null;
		const selection = { turnId, sourceId: citation.id };
		sourceFocusKeyRef.current = selection;
		setTraceOpen(false);
		setActiveSource({ turnId, citation, selectedByUser: true });
		setDrawerOpen(true);
	}, []);

	function updateCitationSnapshot(turnId: string, citations: UiCitation[]) {
		setActiveSource((current) => {
			if (current?.selectedByUser && current.turnId !== turnId) return current;
			const citation = current?.selectedByUser
				? citations.find((citation) => citation.id === current.citation.id)
				: citations[0];
			return citation
				? { turnId, citation, selectedByUser: current?.selectedByUser ?? false }
				: null;
		});
	}

	function sourceReturnTarget() {
		const key = sourceFocusKeyRef.current;
		const trigger = sourceTriggerRef.current;
		if (
			trigger?.isConnected &&
			(!key ||
				(trigger.dataset.citationId === key.sourceId &&
					trigger.closest<HTMLElement>("[data-turn-id]")?.dataset.turnId ===
						key.turnId))
		)
			return trigger;
		// Completion can replace Markdown nodes while the source panel is open.
		const replacement = key
			? document.querySelector<HTMLElement>(
					`[data-turn-id="${CSS.escape(key.turnId)}"] [data-citation-id="${CSS.escape(key.sourceId)}"]`,
				)
			: null;
		return replacement ?? textareaRef.current;
	}

	function closeSources() {
		setDrawerOpen(false);
		if (wideSources)
			window.requestAnimationFrame(() => {
				sourceReturnTarget()?.focus();
			});
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
		askStream.cancel();
	}

	async function handleArchive() {
		if (!canArchive || archivingRef.current) return;
		const readyTurns = turns.filter(
			(turn) => !turn.pending && turn.question.trim() && !turn.error,
		);
		if (readyTurns.length === 0) return;
		const epoch = contextEpochRef.current;
		archivingRef.current = true;
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
					retrieval_debug: turn.retrievalDebug ?? undefined,
				})),
			});
			if (epoch !== contextEpochRef.current) return;
			setThreadId(detail.id);
			setThreadTitle(detail.title);
			setSessionId(detail.session_id || detail.id);
			// Keep Ask blocked until the URL-driven archive hydration has settled.
			router.replace(`/app/ask?thread=${encodeURIComponent(detail.id)}`);
		} catch (err) {
			if (epoch !== contextEpochRef.current) return;
			setArchiveError(
				err instanceof Error ? err.message : "归档失败，请稍后重试",
			);
			archivingRef.current = false;
			setArchiving(false);
		}
	}

	async function submitQuestion(
		question: string,
		options?: { replaceTurnId?: string },
	) {
		const trimmed = question.trim();
		if (!trimmed || !canAsk || !libraryId || archivingRef.current) return;
		if (isStreaming && !options?.replaceTurnId) return;

		const replaceTurnId = options?.replaceTurnId;
		const pendingId = replaceTurnId ?? `pending-${createClientId()}`;
		const startedAtMs = performance.now();
		const startedAt = Date.now();

		askStream.cancel();

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
		}
		setTraceOpen(false);

		await askStream.run(
			{
				question: trimmed,
				libraryId,
				sessionId,
				threadId,
			},
			{
				onMeta: (meta) => {
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
					const mapped = citations.map(toUiCitation);
					const evidenceMs = Math.round(performance.now() - startedAtMs);
					dispatchTurns({
						type: "citations",
						turnId: pendingId,
						citations: mapped,
						evidenceMs,
					});
					updateCitationSnapshot(pendingId, mapped);
				},
				onToken: (token) => {
					dispatchTurns({ type: "token", turnId: pendingId, token });
				},
				onDone: (result) => {
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
							// Completion must not remount this turn or its focused citations.
							id: pendingId,
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
					updateCitationSnapshot(pendingId, citations);
				},
				onTerminal: ({ cancelled, error: err }) => {
					const completedAt = Date.now();
					const durationMs = Math.round(performance.now() - startedAtMs);
					dispatchTurns({
						type: "terminal",
						turnId: pendingId,
						completedAt,
						durationMs,
						cancelled,
						error: cancelled
							? undefined
							: err instanceof Error
								? err.message
								: "请求失败，请确认 API 已启动",
					});
				},
			},
		);
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
		if (event.nativeEvent.isComposing || event.keyCode === 229) return;
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
						if (open) {
							setTraceOpen(false);
							sourceFocusKeyRef.current = null;
							if (document.activeElement instanceof HTMLElement)
								sourceTriggerRef.current = document.activeElement;
						}
						setDrawerOpen(open);
					}}
					onLibraryChange={(nextId) => {
						if (nextId === libraryId) return;
						resetConversation();
						setLibraryId(nextId);
						if (requestedThreadId) router.replace("/app/ask");
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
					<p className="border-b border-survey/35 bg-warning px-5 py-2 text-sm text-warning-foreground">
						原知识库已删除，历史记录仍可查看。选择其他知识库将开启新会话。
					</p>
				) : null}

				<MessageScrollerProvider
					key={`${libraryId}:${requestedThreadId ?? "new"}`}
					autoScroll
				>
					<MessageScroller className="min-h-0 flex-1">
						<MessageScrollerViewport aria-label="问答阅读区">
							{turns.length === 0 ? (
								<div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-14 sm:px-6 sm:py-20">
									<p className="text-xs text-muted-foreground">
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
													: librariesLoading
														? "知识库 · 加载中"
														: libsError
															? "知识库 · 暂不可用"
															: libraries.length === 0
																? "知识库 · 尚未创建"
																: "知识库 · 请选择"}
									</p>
									<h2 className="font-heading text-2xl font-medium text-foreground">
										{canAsk
											? "有什么需要核对？"
											: librariesLoading
												? "正在加载知识库"
												: libsError
													? "知识库加载失败"
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
									<p className="text-sm leading-6 text-muted-foreground">
										{canAsk
											? (library?.name ?? "")
											: librariesLoading
												? "正在读取知识库列表，请稍候。"
												: libsError
													? "可前往知识库页面重试加载。"
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
									{!canAsk && !librariesLoading ? (
										<Link
											href="/app/libraries"
											className={cn(
												buttonVariants({ variant: "outline" }),
												"min-h-11 w-fit rounded-lg",
											)}
										>
											{!libsError && libraries.length === 0
												? "去创建知识库"
												: library?.status === "empty" ||
														library?.doc_count === 0
													? "去上传文档"
													: "前往知识库"}
											<ChevronRight data-icon="inline-end" />
										</Link>
									) : docsLoaded ? (
										<div className="space-y-2">
											<div className="flex flex-col items-start gap-1">
												{sampleQuestions.map((sample) => (
													<Button
														key={sample}
														type="button"
														variant="outline"
														size="sm"
														onClick={() => setInput(sample)}
														className="h-auto min-h-11 max-w-full justify-start px-3 py-2 text-left text-sm leading-6 whitespace-normal text-muted-foreground [overflow-wrap:anywhere]"
													>
														{sample}
													</Button>
												))}
											</div>
										</div>
									) : null}
								</div>
							) : (
								<MessageScrollerContent
									className="@container mx-auto w-full max-w-3xl gap-12 px-4 py-6 sm:px-6 sm:py-8"
									aria-label="问答记录"
								>
									<AskConversationList
										activeCitation={activeCitation}
										activeCitationTurnId={activeSource?.turnId ?? null}
										canAsk={canAsk}
										isStreaming={isStreaming}
										onCancel={cancelAsk}
										onOpenCitation={openCitation}
										onOpenTrace={openTrace}
										onRetry={retryTurn}
										reduceMotion={reduceMotion}
										turns={turns}
									/>
								</MessageScrollerContent>
							)}
						</MessageScrollerViewport>
						<MessageScrollerButton
							className="size-11"
							behavior={reduceMotion ? "auto" : "smooth"}
							aria-label="回到最新回答"
						/>
					</MessageScroller>
				</MessageScrollerProvider>

				<AskComposer
					canAsk={canAsk}
					healthLoading={healthLoading}
					input={input}
					isStreaming={isStreaming}
					onCancel={cancelAsk}
					onChange={setInput}
					onKeyDown={onKeyDown}
					onSubmit={onSubmit}
					textareaRef={textareaRef}
				/>
			</section>

			{!wideSources ? (
				<Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
					<SheetContent
						side="right"
						showCloseButton={false}
						finalFocus={sourceReturnTarget}
						className="w-full max-w-[min(100vw,28rem)]! p-0"
					>
						<SheetHeader className="sr-only">
							<SheetTitle>引用来源</SheetTitle>
							<SheetDescription>
								本次回答使用的来源片段与文档位置
							</SheetDescription>
						</SheetHeader>
						<AskSourcesPanel
							activeCitation={activeCitation}
							onClose={closeSources}
						/>
					</SheetContent>
				</Sheet>
			) : drawerOpen ? (
				<aside
					aria-label="引用来源"
					className="w-96 shrink-0 border-l bg-background"
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.stopPropagation();
							closeSources();
						}
					}}
				>
					<AskSourcesPanel
						activeCitation={activeCitation}
						onClose={closeSources}
					/>
				</aside>
			) : null}

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
