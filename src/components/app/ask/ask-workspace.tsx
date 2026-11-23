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
import {
	askStreamErrorText,
	createAskStreamLifecycle,
} from "@/components/app/ask/ask-stream-lifecycle";
import {
	AskTraceDrawer,
	stageDurationMs,
} from "@/components/app/ask/ask-trace-drawer";
import {
	askTurnsReducer,
	completedTurn,
	type LocalTurn,
	retainAuthorizedTrace,
	toApiCitation,
	toUiCitation,
} from "@/components/app/ask/ask-turn-state";
import { AskWorkspaceHeader } from "@/components/app/ask/ask-workspace-header";
import { useCan } from "@/components/app/can";
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
import { useInterfaceText } from "@/lib/i18n/provider";
import type { UiCitation } from "@/lib/ui-types";
import { cn } from "@/lib/utils";

function documentDisplayTitle(doc: ApiDocument): string {
	const raw = (doc.name || doc.filename || "").trim();
	if (!raw) return "";
	return raw.replace(/\.[A-Za-z0-9]{1,8}$/, "").trim() || raw;
}

/** 根据就绪文档标题生成 2～3 条可点提问；无标题时退回中性文案 */
function buildSampleQuestions(
	docs: ApiDocument[],
	t: ReturnType<typeof useInterfaceText>,
): string[] {
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
		return [
			t("这份资料的主要内容是什么？", "What does this document cover?"),
			t("有哪些关键要点值得注意？", "What are the key takeaways?"),
		];
	}
	return unique.map((title, index) => {
		if (index === 0)
			return t(`《${title}》里说了什么？`, `What does “${title}” say?`);
		if (index === 1)
			return t(
				`关于「${title}」的要点是什么？`,
				`What are the key points in “${title}”?`,
			);
		return t(`总结一下《${title}》的核心内容`, `Summarize “${title}”.`);
	});
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
	const t = useInterfaceText();
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
				{t("加载问答…", "Loading Ask…")}
			</div>
		);
	}
	return <AskWorkspaceContent />;
}

function AskWorkspaceContent() {
	const t = useInterfaceText();
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
	const [threadLibraryId, setThreadLibraryId] = useState("");
	const [threadTitle, setThreadTitle] = useState<string | null>(null);
	const [archiving, setArchiving] = useState(false);
	const archivingRef = useRef(false);
	const [archiveError, setArchiveError] = useState<
		| { kind: "resume_failed" }
		| { kind: "archive_failed"; detail?: string }
		| null
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
	const canInspect = useCan("writeLibraries");
	const [traceRequested, setTraceRequested] = useState(false);
	const [traceTurnId, setTraceTurnId] = useState<string | null>(null);
	const traceTurn = turns.find((turn) => turn.id === traceTurnId);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const sourceTriggerRef = useRef<HTMLElement | null>(null);
	const sourceFocusKeyRef = useRef<{ turnId: string; sourceId: string } | null>(
		null,
	);
	const [askStream] = useState(() =>
		createAskStreamLifecycle(askQuestionStream),
	);
	const pendingArchiveRef = useRef<{
		threadId: string;
		libraryId: string;
		turns: LocalTurn[];
	} | null>(null);
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
	const library = libraries.find(
		(item) =>
			item.id === libraryId &&
			item.status !== "deleting" &&
			item.status !== "deleted",
	);
	const resumeLibraryMissing =
		requestedThreadId && threadLibraryId && !librariesLoading && !library
			? threadLibraryId
			: null;
	const isArchived = Boolean(threadId);
	const canArchive =
		!isArchived &&
		!isStreaming &&
		!archiving &&
		turns.some((turn) => !turn.pending && turn.question.trim());

	const resetConversation = useCallback(() => {
		contextEpochRef.current += 1;
		askStream.cancel(false);
		resumeThreadRef.current = null;
		pendingArchiveRef.current = null;
		setThreadId(undefined);
		setThreadLibraryId("");
		setThreadTitle(null);
		setSessionId(undefined);
		setInput("");
		dispatchTurns({ type: "hydrate", turns: [] });
		setActiveSource(null);
		sourceTriggerRef.current = null;
		sourceFocusKeyRef.current = null;
		setDrawerOpen(false);
		setTraceTurnId(null);
		setTraceRequested(false);
		setArchiveError(null);
		setArchiving(false);
		archivingRef.current = false;
	}, [askStream]);

	useLayoutEffect(() => {
		if (librariesLoading || library) return;
		if (requestedThreadId) {
			// A resumed thread stays bound to its own library through refreshes.
			askStream.cancel();
			return;
		}
		let storedId = "";
		try {
			storedId = window.localStorage.getItem(ASK_LIBRARY_STORAGE_KEY) ?? "";
		} catch {
			// The inventory can still supply the initial selection.
		}
		const nextId = chooseAskLibraryId(libraries, storedId);
		if (libraryId !== nextId) {
			if (libraryId) resetConversation();
			setLibraryId(nextId);
		}
	}, [
		askStream,
		libraries,
		librariesLoading,
		library,
		libraryId,
		requestedThreadId,
		resetConversation,
	]);

	useEffect(() => {
		if (!library) return;
		try {
			window.localStorage.setItem(ASK_LIBRARY_STORAGE_KEY, library.id);
		} catch {
			// Selection still works when persistence is unavailable.
		}
	}, [library]);

	useLayoutEffect(
		() => () => {
			contextEpochRef.current += 1;
			askStream.cancel(false);
		},
		[askStream],
	);

	useLayoutEffect(() => {
		const previous = previousContextRef.current;
		previousContextRef.current = { libraryId, requestedThreadId };
		if (previous.libraryId !== libraryId) askStream.cancel(false);
		if (previous.requestedThreadId !== requestedThreadId) {
			if (pendingArchiveRef.current?.threadId !== requestedThreadId) {
				resetConversation();
			}
		}
	}, [askStream, libraryId, requestedThreadId, resetConversation]);

	useEffect(() => {
		const resumeId = requestedThreadId;
		if (!resumeId || resumeThreadRef.current === resumeId) return;
		if (!apiReady) return;
		if (librariesLoading) return;
		const controller = new AbortController();
		const epoch = contextEpochRef.current;
		const isCurrent = () =>
			!controller.signal.aborted &&
			contextEpochRef.current === epoch &&
			previousContextRef.current.requestedThreadId === resumeId;
		void (async () => {
			try {
				const detail = await continueThread(resumeId, controller.signal);
				if (!isCurrent()) return;
				const archivedLibraryId = (detail.library_id || "").trim();
				const pendingArchive = pendingArchiveRef.current;
				const archivedTurns =
					pendingArchive?.threadId === resumeId &&
					pendingArchive.libraryId === archivedLibraryId
						? pendingArchive.turns
						: [];
				pendingArchiveRef.current = null;
				resumeThreadRef.current = resumeId;
				setActiveSource(null);
				sourceFocusKeyRef.current = null;
				sourceTriggerRef.current = null;
				setDrawerOpen(false);
				setThreadId(detail.id);
				setThreadLibraryId(archivedLibraryId);
				setThreadTitle(detail.title);
				setSessionId(detail.session_id || detail.id);
				setLibraryId(archivedLibraryId);
				dispatchTurns({
					type: "hydrate",
					turns: detail.turns.map((turn, index) => {
						const local = archivedTurns[index];
						// Keep live diagnostics only for the same turn and authorized sources.
						const sameTurn =
							local?.question === turn.question &&
							local.answer === turn.answer &&
							local.citations.length === turn.citations.length &&
							turn.citations.every(
								(citation, i) =>
									citation.id === local.citations[i].id &&
									citation.document_version_id ===
										local.citations[i].source?.document_version_id,
							);
						return {
							id: sameTurn ? local.id : turn.id || `resume-${index}`,
							question: turn.question,
							answer: turn.answer,
							citations: turn.citations.map(toUiCitation),
							refused: turn.refused,
							refuseReason: turn.refuse_reason,
							mode: turn.mode,
							pending: false,
							persisted: true,
							retrievalDebug: turn.retrieval_debug || undefined,
							traceDetails: sameTurn
								? retainAuthorizedTrace(local.traceDetails, turn.citations)
								: undefined,
						};
					}),
				});
				setArchiveError(null);
				archivingRef.current = false;
				setArchiving(false);
			} catch (err) {
				if (!isCurrent() || isAbortError(err)) return;
				resetConversation();
				setArchiveError({ kind: "resume_failed" });
			}
		})();
		return () => controller.abort();
	}, [apiReady, librariesLoading, requestedThreadId, resetConversation]);

	useLayoutEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		if (input) el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
	}, [input]);

	const canAsk = Boolean(
		isAskableLibrary(library) &&
			apiReady &&
			!archiving &&
			(!threadId || libraryId === threadLibraryId) &&
			(!requestedThreadId ||
				(threadId === requestedThreadId &&
					resumeThreadRef.current === requestedThreadId)),
	);

	const sampleQuestions = useMemo(() => {
		if (!canAsk || !docsLoaded) return [];
		return buildSampleQuestions(readyDocuments, t);
	}, [canAsk, docsLoaded, readyDocuments, t]);

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
		setTraceTurnId(null);
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

	function openTrace(turn: LocalTurn) {
		setDrawerOpen(false);
		setTraceTurnId(turn.id);
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
			pendingArchiveRef.current = {
				threadId: detail.id,
				libraryId,
				turns: readyTurns,
			};
			setThreadId(detail.id);
			setThreadLibraryId(libraryId);
			setThreadTitle(detail.title);
			setSessionId(detail.session_id || detail.id);
			// Keep Ask blocked until the URL-driven archive hydration has settled.
			router.replace(`/app/ask?thread=${encodeURIComponent(detail.id)}`);
		} catch (err) {
			if (epoch !== contextEpochRef.current) return;
			setArchiveError({
				kind: "archive_failed",
				detail: err instanceof Error ? err.message : undefined,
			});
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
		setTraceTurnId(null);
		const includeTraceDetails = canInspect && traceRequested;

		await askStream.run(
			{
				question: trimmed,
				libraryId,
				sessionId,
				threadId,
				include_trace_details: includeTraceDetails ? true : undefined,
			},
			{
				onMeta: (meta) => {
					setSessionId(meta.session_id);
					if (meta.thread_id) {
						setThreadId(meta.thread_id);
						setThreadLibraryId(libraryId);
					}
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
					if (result.thread_id) {
						setThreadId(result.thread_id);
						setThreadLibraryId(libraryId);
					}
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
							traceDetails:
								includeTraceDetails &&
								result.retrieval_inspection &&
								result.judge_summary
									? {
											retrieval_inspection: result.retrieval_inspection,
											rewritten_question: result.rewritten_question,
											judge_summary: result.judge_summary,
										}
									: undefined,
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
						error: cancelled ? undefined : askStreamErrorText(err, t),
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
					library={library ?? null}
					libraryId={libraryId}
					onArchive={() => void handleArchive()}
					onDrawerOpenChange={(open) => {
						if (open) {
							setTraceTurnId(null);
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
					traceRequested={traceRequested}
					onTraceRequestedChange={setTraceRequested}
					turnCount={turns.length}
				/>
				{libsError ? (
					<p className="border-b border-destructive/30 bg-destructive/10 px-5 py-1.5 text-sm text-destructive">
						{libsError}
					</p>
				) : null}
				{archiveError ? (
					<p className="border-b border-destructive/30 bg-destructive/10 px-5 py-1.5 text-sm text-destructive">
						{archiveError.kind === "resume_failed"
							? t(
									"无法打开归档会话，请从会话历史重试。",
									"Couldn't open the archived conversation. Try again from Conversations.",
								)
							: (archiveError.detail ??
								t(
									"归档失败，请稍后重试",
									"Couldn't archive. Try again later.",
								))}
					</p>
				) : null}
				{resumeLibraryMissing ? (
					<p className="border-b border-survey/35 bg-warning px-5 py-2 text-sm text-warning-foreground">
						{t(
							"原知识库已删除，历史记录仍可查看。选择其他知识库将开启新会话。",
							"The original library was deleted. You can still view the conversation. Selecting another library starts a new one.",
						)}
					</p>
				) : null}

				<MessageScrollerProvider
					key={`${libraryId}:${requestedThreadId ?? "new"}`}
					autoScroll
				>
					<MessageScroller className="min-h-0 flex-1">
						<MessageScrollerViewport
							aria-label={t("问答阅读区", "Question and answer area")}
						>
							{turns.length === 0 ? (
								<div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-14 sm:px-6 sm:py-20">
									<p className="text-xs text-muted-foreground">
										{healthLoading
											? t("服务状态 · 探测中", "Service · Checking")
											: !apiReady
												? t("服务状态 · 暂不可用", "Service · Unavailable")
												: library
													? `${t("知识库", "Library")} · ${library.name}${
															library.status === "empty"
																? t(" · 空", " · Empty")
																: library.status === "indexing"
																	? t(" · 索引中", " · Indexing")
																	: ""
														}`
													: librariesLoading
														? t("知识库 · 加载中", "Library · Loading")
														: libsError
															? t("知识库 · 暂不可用", "Library · Unavailable")
															: libraries.length === 0
																? t(
																		"知识库 · 尚未创建",
																		"Library · Not created",
																	)
																: t("知识库 · 请选择", "Library · Select one")}
									</p>
									<h2 className="font-heading text-2xl font-medium text-foreground">
										{canAsk
											? t("有什么需要核对？", "What would you like to know?")
											: librariesLoading
												? t("正在加载知识库", "Loading libraries")
												: libsError
													? t("知识库加载失败", "Couldn't load libraries")
													: healthLoading
														? t("正在检查服务状态", "Checking service status")
														: !apiReady
															? t("服务暂不可用", "Service unavailable")
															: !library
																? libraries.length === 0
																	? t("还没有知识库", "No libraries yet")
																	: t("请选择知识库", "Select a library")
																: library.status === "empty"
																	? t("知识库还是空的", "This library is empty")
																	: library.status === "failed"
																		? t(
																				"文档处理失败",
																				"Document processing failed",
																			)
																		: t(
																				"文档仍在索引中",
																				"Documents are still indexing",
																			)}
									</h2>
									<p className="text-sm leading-6 text-muted-foreground">
										{canAsk
											? (library?.name ?? "")
											: librariesLoading
												? t(
														"正在读取知识库列表，请稍候。",
														"Loading the list of libraries.",
													)
												: libsError
													? t(
															"可前往知识库页面重试加载。",
															"Try reloading from Knowledge libraries.",
														)
													: healthLoading
														? t(
																"正在连接知识库服务，请稍候。",
																"Connecting to the knowledge service.",
															)
														: !apiReady || libsError
															? t(
																	"请先恢复 API 连接后再提问。",
																	"Restore the API connection before asking a question.",
																)
															: !library
																? libraries.length === 0
																	? t(
																			"先到「知识库」创建空间并上传文档。",
																			"Create a library and upload documents.",
																		)
																	: t(
																			"从上方选择一个已就绪的知识库。",
																			"Select a ready library above.",
																		)
																: library.status === "empty"
																	? t(
																			"先上传文档完成索引，再回来提问。",
																			"Upload documents and wait for indexing before asking.",
																		)
																	: library.status === "failed"
																		? t(
																				"当前没有可检索文档，请到知识库查看失败原因并重试。",
																				"No searchable documents. Check the failures in Knowledge libraries, then retry.",
																			)
																		: t(
																				"索引完成后即可提问，可先到知识库查看进度。",
																				"Ask when indexing finishes. Check progress in Knowledge libraries.",
																			)}
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
												? t("去创建知识库", "Create a library")
												: library?.status === "empty" ||
														library?.doc_count === 0
													? t("去上传文档", "Upload documents")
													: t("前往知识库", "Open Knowledge libraries")}
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
														className="h-auto min-h-11 max-w-full justify-start border-border bg-card px-3 py-2 text-left text-sm leading-6 whitespace-normal text-muted-foreground shadow-2xs hover:bg-accent hover:text-accent-foreground dark:border-border dark:bg-card dark:hover:bg-accent [overflow-wrap:anywhere]"
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
									aria-label={t("问答记录", "Question history")}
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
							aria-label={t("回到最新回答", "Back to latest answer")}
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
							<SheetTitle>{t("引用来源", "Sources")}</SheetTitle>
							<SheetDescription>
								{t(
									"本次回答使用的来源片段与文档位置",
									"Evidence excerpts and document locations for this answer",
								)}
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
					aria-label={t("引用来源", "Sources")}
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
				open={traceTurn != null}
				onOpenChange={(open) => {
					if (!open) setTraceTurnId(null);
				}}
				debug={traceTurn?.retrievalDebug ?? null}
				details={canInspect ? traceTurn?.traceDetails : undefined}
				canInspect={canInspect}
				clientDurationMs={traceTurn?.durationMs}
			/>
		</div>
	);
}
