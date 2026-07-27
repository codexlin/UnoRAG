"use client";

import {
	Activity,
	Archive,
	Bot,
	ChevronRight,
	PanelRightClose,
	PanelRightOpen,
	RefreshCw,
	Send,
	Square,
	UserRound,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
	type FormEvent,
	type KeyboardEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import {
	AskTraceDrawer,
	hasAskTrace,
	stageDurationMs,
} from "@/components/app/ask-trace-drawer";
import { CitationSourceCard } from "@/components/app/citation-source-card";
import { LibraryCombobox } from "@/components/app/library-combobox";
import { MarkdownAnswer } from "@/components/app/markdown-answer";
import { Button, buttonVariants } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHealth } from "@/hooks/use-health";
import { useLibraries } from "@/hooks/use-libraries";
import { useIsMobile } from "@/hooks/use-mobile";
import {
	type ApiCitation,
	type ApiDocument,
	type ApiRetrievalDebug,
	archiveThread,
	askQuestionStream,
	continueThread,
	fetchDocuments,
	isAbortError,
} from "@/lib/api";
import {
	ASK_LIBRARY_STORAGE_KEY,
	chooseAskLibraryId,
} from "@/lib/ask-library-selection.mjs";
import { formatDateTime, formatDurationMs, formatScore } from "@/lib/format";
import type { UiCitation, UiTurn } from "@/lib/ui-types";
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

type LocalTurn = UiTurn & {
	pending?: boolean;
	error?: string;
	cancelled?: boolean;
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
	/** ms until first citations / evidence event (client wall-clock; not shown as 检索) */
	evidenceMs?: number;
	/** server retrieve stage duration_ms from retrieval_debug.stages */
	retrieveMs?: number;
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
	if (turn.persistError) {
		notices.push(`归档写入失败：${turn.persistError}`);
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

function SourcesPanelContent({
	activeCitation,
	onClose,
}: {
	activeCitation: UiCitation | null;
	onClose: () => void;
}) {
	return (
		<div className="flex h-full min-h-0 w-full flex-col">
			<div className="flex h-12 shrink-0 items-center justify-between border-b border-border/70 px-4">
				<div>
					<p className="text-meta font-mono tracking-[0.16em] text-cite uppercase">
						Sources
					</p>
					<p className="text-[0.9375rem] font-medium leading-snug text-foreground">
						引用来源
					</p>
				</div>
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								type="button"
								onClick={onClose}
								className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-meta text-muted-foreground transition-colors hover:border-cite/40 hover:bg-cite/8 hover:text-cite"
								aria-label="收起引用来源面板"
							>
								<PanelRightClose className="size-3.5" aria-hidden />
								收起
							</button>
						}
					/>
					<TooltipContent side="left">关闭引用来源面板</TooltipContent>
				</Tooltip>
			</div>
			<ScrollArea className="min-h-0 flex-1">
				<div className="p-4">
					{activeCitation ? (
						<div className="desk-enter">
							<CitationSourceCard citation={activeCitation} active expanded />
						</div>
					) : (
						<div className="text-ui desk-enter space-y-2 text-muted-foreground">
							<p>
								这里展示本轮检索命中的原文片段。点击答案中的引用编号或下方来源卡片即可核对
								dense / bm25 / rrf 等分数。
							</p>
							<p className="text-meta font-mono text-muted-foreground/80">
								需要时可通过顶栏的「引用来源」再次打开。
							</p>
						</div>
					)}
				</div>
			</ScrollArea>
		</div>
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
	const {
		libraries,
		error: libsError,
		loading: librariesLoading,
	} = useLibraries();
	const { apiReady } = useHealth();
	const [libraryId, setLibraryId] = useState("");
	const [input, setInput] = useState("");
	const [sessionId, setSessionId] = useState<string | undefined>();
	const [threadId, setThreadId] = useState<string | undefined>();
	const [threadTitle, setThreadTitle] = useState<string | null>(null);
	const [archiving, setArchiving] = useState(false);
	const [archiveError, setArchiveError] = useState<string | null>(null);
	const [turns, setTurns] = useState<LocalTurn[]>([]);
	const [activeCitation, setActiveCitation] = useState<UiCitation | null>(null);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [traceDebug, setTraceDebug] = useState<ApiRetrievalDebug | null>(null);
	const [traceClientMs, setTraceClientMs] = useState<number | null>(null);
	const [traceOpen, setTraceOpen] = useState(false);
	const [readyDocuments, setReadyDocuments] = useState<ApiDocument[]>([]);
	const [docsLoaded, setDocsLoaded] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const abortRef = useRef<AbortController | null>(null);
	const activeTurnIdRef = useRef<string | null>(null);
	const resumeThreadRef = useRef<string | null>(null);

	const isStreaming = turns.some((turn) => turn.pending);
	const isArchived = Boolean(threadId);
	const canArchive =
		!isArchived &&
		!isStreaming &&
		!archiving &&
		turns.some((turn) => !turn.pending && turn.question.trim());

	useEffect(() => {
		if (librariesLoading) return;
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
	}, [libraries, librariesLoading, libraryId]);

	useEffect(() => {
		return () => {
			abortRef.current?.abort();
		};
	}, []);

	useEffect(() => {
		const resumeId = (searchParams.get("thread") || "").trim();
		if (!resumeId || resumeThreadRef.current === resumeId) return;
		if (!apiReady) return;
		resumeThreadRef.current = resumeId;
		const controller = new AbortController();
		void (async () => {
			try {
				const detail = await continueThread(resumeId, controller.signal);
				if (controller.signal.aborted) return;
				setThreadId(detail.id);
				setThreadTitle(detail.title);
				setSessionId(detail.session_id || detail.id);
				if (detail.library_id) setLibraryId(detail.library_id);
				setTurns(
					detail.turns.map((turn, index) => ({
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
				);
				setArchiveError(null);
			} catch (err) {
				if (controller.signal.aborted || isAbortError(err)) return;
				setArchiveError("无法打开归档会话，请从会话历史重试。");
			}
		})();
		return () => controller.abort();
	}, [apiReady, searchParams]);

	useEffect(() => {
		if (!libraryId || !apiReady) {
			setReadyDocuments([]);
			setDocsLoaded(false);
			return;
		}
		const controller = new AbortController();
		setDocsLoaded(false);
		setReadyDocuments([]);
		void (async () => {
			try {
				const items = await fetchDocuments(libraryId, controller.signal);
				if (controller.signal.aborted) return;
				setReadyDocuments(items.filter((doc) => doc.status === "ready"));
				setDocsLoaded(true);
			} catch (err) {
				if (controller.signal.aborted || isAbortError(err)) return;
				setReadyDocuments([]);
				setDocsLoaded(true);
			}
		})();
		return () => controller.abort();
	}, [libraryId, apiReady]);

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

	const canAsk = Boolean(library && library.status === "ready" && apiReady);

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
					citations: turn.citations.map((citation) => ({
						id: citation.id,
						index: citation.index,
						title: citation.title,
						page: citation.page ?? null,
						section_path: citation.sectionPath ?? null,
						preamble: citation.preamble ?? null,
						snippet: citation.snippet || citation.text.slice(0, 280),
						text: citation.text,
						score: citation.score ?? 0,
						dense_score: citation.denseScore ?? null,
						bm25_score: citation.bm25Score ?? null,
						rrf_score: citation.rrfScore ?? null,
						used_rerank: Boolean(citation.usedRerank),
						used_hybrid: Boolean(citation.usedHybrid),
						doc_id: citation.docId ?? null,
						chunk_index: citation.chunkIndex ?? null,
						filename: citation.filename ?? null,
					})),
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

		if (replaceTurnId) {
			setTurns((prev) =>
				prev.map((turn) =>
					turn.id === replaceTurnId
						? {
								id: pendingId,
								question: trimmed,
								answer: "",
								citations: [],
								pending: true,
								error: undefined,
								cancelled: undefined,
								refused: undefined,
								refuseReason: undefined,
								mode: undefined,
								evidenceReady: false,
								hybridFailed: undefined,
								rerankFailed: undefined,
								retrievalMode: undefined,
								persisted: undefined,
								persistError: undefined,
								topScore: undefined,
								usedHybrid: undefined,
								startedAtMs,
								startedAt,
								completedAt: undefined,
								durationMs: undefined,
								evidenceMs: undefined,
								retrievalDebug: undefined,
							}
						: turn,
				),
			);
		} else {
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
						if (activeTurnIdRef.current !== pendingId) return;
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
						if (activeTurnIdRef.current !== pendingId) return;
						setTurns((prev) =>
							prev.map((turn) =>
								turn.id === pendingId
									? {
											...turn,
											answer: `${turn.answer}${token}`,
											pending: true,
										}
									: turn,
							),
						);
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
											cancelled: false,
											error: undefined,
											evidenceReady: true,
											startedAt,
											completedAt,
											durationMs,
											evidenceMs: turn.evidenceMs,
											retrieveMs: retrieveMs ?? undefined,
											retrievalDebug: debug,
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
											persisted: result.persisted === true,
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
				controller.signal,
			);
		} catch (err) {
			const completedAt = Date.now();
			const durationMs = Math.round(performance.now() - startedAtMs);
			const aborted = controller.signal.aborted || isAbortError(err);

			if (aborted) {
				setTurns((prev) =>
					prev.map((turn) =>
						turn.id === pendingId
							? {
									...turn,
									id: `turn-${Date.now()}`,
									pending: false,
									cancelled: true,
									error: undefined,
									completedAt,
									durationMs,
								}
							: turn,
					),
				);
				return;
			}

			const message =
				err instanceof Error ? err.message : "请求失败，请确认 API 已启动";
			setTurns((prev) =>
				prev.map((turn) =>
					turn.id === pendingId
						? {
								...turn,
								id: `turn-${Date.now()}`,
								pending: false,
								cancelled: false,
								error: message,
								completedAt,
								durationMs,
							}
						: turn,
				),
			);
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
				<div className="flex h-12 shrink-0 items-center gap-3 border-b border-border/70 bg-card/50 px-4 sm:px-5">
					<div className="min-w-0 flex-1 sm:max-w-xs">
						<LibraryCombobox
							libraries={libraries}
							value={libraryId}
							onValueChange={setLibraryId}
							showLabel={false}
							className="w-full"
						/>
					</div>

					<Separator orientation="vertical" className="hidden h-6 sm:block" />

					<div className="hidden min-w-0 items-center gap-2.5 text-ui text-muted-foreground md:flex">
						{libraries.length === 0 ? (
							<Link
								href="/app/libraries"
								className="inline-flex items-center gap-1 font-medium text-cite underline-offset-4 hover:underline"
							>
								去创建知识库
								<ChevronRight className="size-3.5" />
							</Link>
						) : !library ? (
							<span>请选择知识库</span>
						) : library.doc_count === 0 || library.status === "empty" ? (
							<Link
								href="/app/libraries"
								className="inline-flex items-center gap-1 font-medium text-cite underline-offset-4 hover:underline"
							>
								知识库为空，去上传文档
								<ChevronRight className="size-3.5" />
							</Link>
						) : (
							<span
								className="inline-flex items-center gap-1.5"
								title="已完成索引、可检索的文档数 / 知识库内文档总数"
							>
								<span
									className={cn(
										"size-1.5 rounded-full",
										library.status === "ready"
											? "bg-cite"
											: library.status === "indexing"
												? "animate-pulse bg-survey"
												: "bg-muted-foreground/50",
									)}
									aria-hidden
								/>
								<span className="tabular-nums text-foreground/80">
									{library.ready_count}/{library.doc_count}
								</span>
								<span>文档已索引</span>
							</span>
						)}
						<span className="text-border" aria-hidden>
							|
						</span>
						<span className="inline-flex items-center gap-1 tabular-nums">
							<span className="text-foreground/80">{turns.length}</span>
							<span>问</span>
						</span>
						{isArchived ? (
							<>
								<span className="text-border" aria-hidden>
									|
								</span>
								<span className="truncate text-cite" title={threadTitle || ""}>
									已归档
									{threadTitle ? ` · ${threadTitle}` : ""}
								</span>
							</>
						) : turns.length > 0 ? (
							<>
								<span className="text-border" aria-hidden>
									|
								</span>
								<span title="关闭或刷新后可能丢失">未归档</span>
							</>
						) : null}
					</div>

					<div className="ml-auto flex shrink-0 items-center gap-2">
						<Tooltip>
							<TooltipTrigger
								render={
									<Button
										type="button"
										variant="outline"
										size="sm"
										className="rounded-lg"
										disabled={!canArchive}
										onClick={() => void handleArchive()}
										aria-label="归档当前会话"
									>
										<Archive data-icon="inline-start" />
										<span className="hidden sm:inline">
											{archiving ? "归档中…" : isArchived ? "已归档" : "归档"}
										</span>
									</Button>
								}
							/>
							<TooltipContent side="bottom">
								{isArchived
									? "当前为归档会话，续聊会自动保存"
									: "把当前临时会话写入档案，之后可继续对话"}
							</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger
								render={
									<Button
										type="button"
										variant={drawerOpen ? "secondary" : "outline"}
										size="sm"
										className={cn(
											"rounded-lg",
											drawerOpen
												? "border-cite/40 bg-cite/10 text-cite hover:bg-cite/15"
												: "border-cite/35 text-cite hover:border-cite/55 hover:bg-cite/8",
										)}
										onClick={() => {
											setDrawerOpen((open) => {
												const next = !open;
												if (next) setTraceOpen(false);
												return next;
											});
										}}
										aria-pressed={drawerOpen}
										aria-label={
											drawerOpen ? "收起引用来源面板" : "展开引用来源面板"
										}
									>
										{drawerOpen ? (
											<PanelRightClose data-icon="inline-start" />
										) : (
											<PanelRightOpen data-icon="inline-start" />
										)}
										<span className="hidden sm:inline">
											{drawerOpen ? "收起引用" : "引用来源"}
										</span>
										<span className="sm:hidden">
											{drawerOpen ? "收起" : "引用"}
										</span>
									</Button>
								}
							/>
							<TooltipContent side="bottom">
								{drawerOpen
									? "收起右侧引用来源面板"
									: "展开右侧引用来源，查看原文与 rank / dense 分数"}
							</TooltipContent>
						</Tooltip>
					</div>
				</div>
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

				<ScrollArea className="min-h-0 flex-1">
					<div className="px-5 py-6">
						{turns.length === 0 ? (
							<div className="desk-enter mx-auto flex max-w-xl flex-col gap-5 py-10">
								<p className="text-meta font-mono tracking-[0.14em] text-cite">
									{!apiReady
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
										: !apiReady
											? "服务暂不可用"
											: !library
												? libraries.length === 0
													? "还没有知识库"
													: "请选择知识库"
												: library.status === "empty"
													? "知识库还是空的"
													: "文档仍在索引中"}
								</h2>
								<p className="text-answer desk-enter desk-enter-delay-1 text-muted-foreground">
									{canAsk
										? "支持流式回答与来源核对。每条回复会显示耗时、检索模式与引用分数；点击答案中的编号可打开引用来源。"
										: !apiReady || libsError
											? "请先恢复 API 连接后再提问。"
											: !library
												? libraries.length === 0
													? "先到「知识库」创建空间并上传文档。"
													: "从上方选择一个已就绪的知识库。"
												: library.status === "empty"
													? "先上传文档完成索引，再回来提问。"
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
													className="rounded-full border border-border/80 bg-card/90 px-3.5 py-2 text-left text-xs leading-5 text-muted-foreground transition-all hover:border-cite/40 hover:bg-cite/5 hover:text-foreground"
												>
													{sample}
												</button>
											))}
										</div>
									</div>
								) : null}
							</div>
						) : (
							<ul className="mx-auto flex max-w-3xl flex-col gap-8">
								{turns.map((turn, turnIndex) => (
									<li
										key={turn.id}
										className="desk-enter space-y-5"
										style={{
											animationDelay: `${Math.min(turnIndex, 4) * 40}ms`,
										}}
									>
										<div className="flex justify-end gap-3">
											<div className="max-w-[min(85%,36rem)] space-y-1.5">
												{turn.startedAt ? (
													<p className="text-meta text-right font-mono text-muted-foreground">
														{formatDateTime(turn.startedAt)}
													</p>
												) : null}
												<div className="text-answer rounded-2xl rounded-br-md bg-primary px-4 py-3 text-primary-foreground shadow-sm">
													{turn.question}
												</div>
											</div>
											<div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary ring-1 ring-primary/20">
												<UserRound className="size-4" aria-hidden />
											</div>
										</div>

										<div className="flex gap-3">
											<div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full border border-cite/30 bg-cite/10 text-cite">
												<Bot className="size-4" aria-hidden />
											</div>
											<div className="min-w-0 max-w-[min(92%,42rem)] flex-1 space-y-3">
												<div className="rounded-2xl rounded-bl-md border border-border/70 bg-card/95 px-4 py-4 shadow-sm">
													<div className="flex flex-wrap items-center justify-between gap-2">
														<p className="text-meta font-mono tracking-[0.14em] text-cite uppercase">
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
																<span className="meta-chip text-survey">
																	已取消
																</span>
															) : null}
															{turn.durationMs != null ? (
																<span
																	className="meta-chip text-foreground/80"
																	title="浏览器端到端：点发送到回答完成（含网络）"
																>
																	端到端 {formatDurationMs(turn.durationMs)}
																</span>
															) : null}
															{turn.retrieveMs != null ? (
																<span
																	className="meta-chip"
																	title="服务端 retrieve 阶段耗时（与链路抽屉一致）"
																>
																	检索 {formatDurationMs(turn.retrieveMs)}
																</span>
															) : turn.pending && turn.evidenceMs != null ? (
																<span
																	className="meta-chip text-muted-foreground"
																	title="首包引用到达时间（客户端，生成完成后会换成服务端检索）"
																>
																	首包 {formatDurationMs(turn.evidenceMs)}
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
																	{turn.citations.length} 引用
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
																						openTrace(
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
																	<TooltipContent
																		side="top"
																		className="max-w-[16rem]"
																	>
																		查看请求链路：路由 / 检索 / 裁决 /
																		生成各阶段耗时与 trace_id
																	</TooltipContent>
																</Tooltip>
															) : null}
														</div>
													</div>
													{turn.pending &&
													!turn.answer &&
													!turn.evidenceReady ? (
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
																	<AnswerBody
																		answer={turn.answer}
																		citations={turn.citations}
																		pending={turn.pending}
																		onCite={openCitation}
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
																onClick={cancelAsk}
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
												</div>

												{canRetryTurn(turn) ? (
													<div>
														<Button
															type="button"
															variant="outline"
															size="sm"
															disabled={!canAsk || isStreaming}
															onClick={() => retryTurn(turn)}
															className="rounded-md"
														>
															<RefreshCw data-icon="inline-start" />
															重试
														</Button>
													</div>
												) : null}

												{turn.citations.length > 0 ? (
													<div className="space-y-2">
														<p className="font-mono text-[11px] text-muted-foreground">
															引用来源 · {turn.citations.length} 条
															{turn.completedAt
																? ` · 完成于 ${formatDateTime(turn.completedAt)}`
																: ""}
														</p>
														<ul className="space-y-2">
															{turn.citations.map((citation) => (
																<li key={citation.id}>
																	<CitationSourceCard
																		citation={citation}
																		active={activeCitation?.id === citation.id}
																		onSelect={openCitation}
																	/>
																</li>
															))}
														</ul>
													</div>
												) : turn.refused && !turn.pending && !turn.error ? (
													<p className="font-mono text-[11px] text-muted-foreground">
														无可用引用来源
													</p>
												) : null}
											</div>
										</div>
									</li>
								))}
							</ul>
						)}
					</div>
				</ScrollArea>

				<form
					onSubmit={onSubmit}
					className="bg-linear-to-t from-background via-background/90 to-transparent px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-5"
				>
					<div className="mx-auto max-w-3xl">
						<div
							className={cn(
								"flex items-end gap-2 rounded-3xl border border-border/60 bg-card/95 px-3.5 py-2 shadow-[0_8px_30px_-12px_rgba(15,23,42,0.18)] ring-1 ring-black/4 backdrop-blur-md transition-[border-color,box-shadow] dark:ring-white/6",
								"focus-within:border-cite/35 focus-within:shadow-[0_10px_36px_-14px_rgba(26,122,109,0.28)] focus-within:ring-cite/15",
								!canAsk && "opacity-80",
							)}
						>
							<Textarea
								ref={textareaRef}
								value={input}
								onChange={(event) => {
									setInput(event.target.value);
									resizeComposer(event.target);
								}}
								onKeyDown={onKeyDown}
								disabled={!canAsk || isStreaming}
								rows={1}
								placeholder={
									isStreaming
										? "生成中… 可点击停止"
										: canAsk
											? "向知识库提问…"
											: "知识库就绪后再提问…"
								}
								className="text-answer max-h-50 min-h-11 flex-1 resize-none border-0 bg-transparent px-0 py-2.5 shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
							/>
							{isStreaming ? (
								<Button
									type="button"
									size="icon"
									variant="outline"
									aria-label="停止生成"
									title="停止生成"
									onClick={cancelAsk}
									className="mb-0.5 size-9 shrink-0 rounded-full border-survey/40 text-survey shadow-sm transition-transform hover:bg-survey/10 active:scale-[0.96]"
								>
									<Square className="size-3.5 fill-current" />
								</Button>
							) : (
								<Button
									type="submit"
									size="icon"
									disabled={!canAsk || !input.trim()}
									aria-label="发送"
									className="mb-0.5 size-9 shrink-0 rounded-full bg-primary text-primary-foreground shadow-sm transition-transform hover:bg-primary/90 active:scale-[0.96] disabled:shadow-none"
								>
									<Send className="size-4" />
								</Button>
							)}
						</div>
						<p className="text-meta mt-2 text-center font-mono tracking-wide text-muted-foreground/60">
							{isStreaming
								? "点击停止按钮取消当前回答"
								: "Enter 发送 · Shift+Enter 换行"}
						</p>
					</div>
				</form>
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
						Sources
					</span>
				</button>
			) : null}

			{isMobile ? (
				<Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
					<SheetContent
						side="right"
						showCloseButton={false}
						className="w-[min(92vw,360px)] p-0"
					>
						<SheetHeader className="sr-only">
							<SheetTitle>引用来源</SheetTitle>
							<SheetDescription>
								查看回答所依据的原文片段与检索分数
							</SheetDescription>
						</SheetHeader>
						<SourcesPanelContent
							activeCitation={activeCitation}
							onClose={() => setDrawerOpen(false)}
						/>
					</SheetContent>
				</Sheet>
			) : (
				<aside
					className={cn(
						"hidden shrink-0 overflow-hidden border-l border-border/80 bg-card/85 backdrop-blur-sm transition-[width,opacity] duration-200 md:block",
						drawerOpen ? "w-[360px] opacity-100" : "w-0 border-l-0 opacity-0",
					)}
					aria-hidden={!drawerOpen}
				>
					<div className="h-full w-[360px]">
						<SourcesPanelContent
							activeCitation={activeCitation}
							onClose={() => setDrawerOpen(false)}
						/>
					</div>
				</aside>
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
