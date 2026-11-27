"use client";

import {
	ArrowLeft,
	ArrowUp,
	Loader2,
	MessageSquare,
	Search,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CitationSourceCard } from "@/components/app/citation-source-card";
import { MarkdownAnswer } from "@/components/app/markdown-answer";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useLibraries } from "@/hooks/use-libraries";
import {
	type ApiArchiveTurn,
	type ApiCitation,
	type ApiThread,
	type ApiThreadDetail,
	fetchThread,
	fetchThreadsPage,
	isAbortError,
	UNLINKED_THREAD_LIBRARY_FILTER,
} from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useInterfaceLanguage, useInterfaceText } from "@/lib/i18n/provider";
import type { UiCitation } from "@/lib/ui-types";
import { cn } from "@/lib/utils";

function toUiCitation(citation: ApiCitation): UiCitation {
	const text = citation.body || citation.text || citation.snippet || "";
	return {
		source: citation,
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

function dateGroup(
	value: string,
	locale: "zh-CN" | "en",
	t: ReturnType<typeof useInterfaceText>,
) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return t("日期未记录", "Date unavailable");
	return date.toLocaleDateString(locale === "zh-CN" ? "zh-CN" : "en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
	});
}

export function ArchivePanel() {
	const { locale } = useInterfaceLanguage();
	const t = useInterfaceText();
	const { libraries } = useLibraries();
	const [threads, setThreads] = useState<ApiThread[]>([]);
	const [totalCount, setTotalCount] = useState<number | null>(null);
	const [hasMore, setHasMore] = useState(false);
	const [nextCursor, setNextCursor] = useState<string | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
	const [selectedId, setSelectedId] = useState("");
	const [detail, setDetail] = useState<ApiThreadDetail | null>(null);
	const [selectedTurnId, setSelectedTurnId] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [detailError, setDetailError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [detailLoading, setDetailLoading] = useState(false);
	const [query, setQuery] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const [libraryFilter, setLibraryFilter] = useState("all");
	const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
	const [listRetry, setListRetry] = useState(0);
	const [detailRetry, setDetailRetry] = useState(0);
	const [focusedCitationId, setFocusedCitationId] = useState("");
	const listTriggerRef = useRef<HTMLButtonElement | null>(null);
	const searchRef = useRef<HTMLInputElement | null>(null);
	const backRef = useRef<HTMLButtonElement | null>(null);
	const citationTriggerRef = useRef<HTMLElement | null>(null);
	const citationRefs = useRef(new Map<string, HTMLLIElement>());
	const loadMoreControllerRef = useRef<AbortController | null>(null);

	useEffect(() => {
		const trimmed = query.trim();
		if (!trimmed) {
			setDebouncedQuery("");
			return;
		}
		const timer = window.setTimeout(() => {
			setDebouncedQuery(trimmed);
		}, 200);
		return () => window.clearTimeout(timer);
	}, [query]);

	const activeLibraryParam =
		libraryFilter === "all"
			? undefined
			: libraryFilter === UNLINKED_THREAD_LIBRARY_FILTER
				? null
				: libraryFilter;

	// biome-ignore lint/correctness/useExhaustiveDependencies: Retry intentionally restarts and aborts the request.
	useEffect(() => {
		loadMoreControllerRef.current?.abort();
		loadMoreControllerRef.current = null;
		setLoadingMore(false);
		setLoadMoreError(null);
		const controller = new AbortController();
		void (async () => {
			setLoading(true);
			try {
				const page = await fetchThreadsPage({
					limit: 40,
					query: debouncedQuery || undefined,
					libraryId: activeLibraryParam,
					signal: controller.signal,
				});
				if (controller.signal.aborted) return;
				setThreads(page.items);
				setHasMore(page.has_more);
				setNextCursor(page.next_cursor);
				setTotalCount(page.total);
				setSelectedId((prev) =>
					prev && page.items.some((item) => item.id === prev)
						? prev
						: page.items[0]?.id || "",
				);
				setError(null);
			} catch (err) {
				if (controller.signal.aborted || isAbortError(err)) return;
				setThreads([]);
				setHasMore(false);
				setNextCursor(null);
				setTotalCount(null);
				setError(
					t(
						"无法加载归档会话，请稍后重试。",
						"Couldn't load archived conversations. Try again later.",
					),
				);
			} finally {
				if (!controller.signal.aborted) setLoading(false);
			}
		})();
		return () => controller.abort();
	}, [debouncedQuery, activeLibraryParam, listRetry]);

	async function loadMoreThreads() {
		if (!hasMore || !nextCursor || loadingMore || loading) return;
		loadMoreControllerRef.current?.abort();
		const controller = new AbortController();
		loadMoreControllerRef.current = controller;
		setLoadingMore(true);
		setLoadMoreError(null);
		try {
			const page = await fetchThreadsPage({
				limit: 40,
				query: debouncedQuery || undefined,
				libraryId: activeLibraryParam,
				cursor: nextCursor,
				signal: controller.signal,
			});
			if (controller.signal.aborted) return;
			setThreads((prev) => {
				const seen = new Set(prev.map((item) => item.id));
				const appended = page.items.filter((item) => !seen.has(item.id));
				return [...prev, ...appended];
			});
			setHasMore(page.has_more);
			setNextCursor(page.next_cursor);
			if (page.total !== null) setTotalCount(page.total);
		} catch (err) {
			if (controller.signal.aborted || isAbortError(err)) return;
			setLoadMoreError(
				t(
					"加载更多会话失败，请重试。",
					"Couldn't load older conversations. Try again.",
				),
			);
		} finally {
			if (loadMoreControllerRef.current === controller) {
				loadMoreControllerRef.current = null;
			}
			if (!controller.signal.aborted) setLoadingMore(false);
		}
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: Retry intentionally restarts and aborts the request.
	useEffect(() => {
		if (!selectedId) {
			setDetail(null);
			setSelectedTurnId("");
			return;
		}
		const controller = new AbortController();
		setDetail(null);
		setDetailError(null);
		setFocusedCitationId("");
		void (async () => {
			setDetailLoading(true);
			try {
				const item = await fetchThread(selectedId, controller.signal);
				if (controller.signal.aborted) return;
				setDetail(item);
				// turns are oldest→newest; default to latest round for review.
				const last = item.turns[item.turns.length - 1];
				setSelectedTurnId(last?.id || item.turns[0]?.id || "");
				setDetailError(null);
			} catch (err) {
				if (controller.signal.aborted || isAbortError(err)) return;
				setDetail(null);
				setDetailError(
					t(
						"无法加载该会话的消息，可能已不可访问。",
						"Couldn't load the conversation. It may no longer be accessible.",
					),
				);
			} finally {
				if (!controller.signal.aborted) setDetailLoading(false);
			}
		})();
		return () => controller.abort();
	}, [selectedId, detailRetry]);

	useEffect(() => {
		if (mobileDetailOpen && backRef.current?.getClientRects().length) {
			backRef.current.focus();
		}
	}, [mobileDetailOpen]);

	function returnToList() {
		setMobileDetailOpen(false);
		requestAnimationFrame(() => {
			const target = listTriggerRef.current;
			if (target?.isConnected && target.getClientRects().length) target.focus();
			else searchRef.current?.focus();
		});
	}

	const libraryNames = new Map(libraries.map((item) => [item.id, item.name]));
	const hasUnlinkedThreads =
		libraryFilter === UNLINKED_THREAD_LIBRARY_FILTER ||
		threads.some((thread) => !thread.library_id);
	const libraryIds = Array.from(
		new Set([
			...libraries.map((item) => item.id),
			...threads
				.map((thread) => thread.library_id)
				.filter((id): id is string => Boolean(id)),
		]),
	);
	const libraryName = (id: string | null | undefined) =>
		id ? libraryNames.get(id) || id : t("未关联知识库", "No linked library");
	const libraryOptions = [
		{ value: "all", label: t("全部知识库", "All libraries") },
		...libraryIds.map((id) => ({ value: id, label: libraryName(id) })),
		...(hasUnlinkedThreads
			? [
					{
						value: UNLINKED_THREAD_LIBRARY_FILTER,
						label: t("未关联知识库", "No linked library"),
					},
				]
			: []),
	];
	const hasActiveFilters = Boolean(debouncedQuery || libraryFilter !== "all");
	const groups = new Map<string, ApiThread[]>();
	for (const thread of threads) {
		const label = dateGroup(thread.updated_at, locale, t);
		const group = groups.get(label) ?? [];
		group.push(thread);
		groups.set(label, group);
	}
	const currentDetail = detail?.id === selectedId ? detail : null;

	const selectedTurn: ApiArchiveTurn | null =
		currentDetail?.turns.find((item) => item.id === selectedTurnId) ??
		currentDetail?.turns[0] ??
		null;
	const turnOptions =
		currentDetail?.turns.map((turn, index) => ({
			value: turn.id,
			label: t(
				`第 ${index + 1} 轮 · ${turn.question}`,
				`Turn ${index + 1} · ${turn.question}`,
			),
		})) ?? [];

	return (
		<div className="@container flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
			<div className="flex min-h-0 min-w-0 flex-1">
				<aside
					aria-label={t("会话历史导航", "Conversation navigation")}
					className={cn(
						"min-h-0 min-w-0 flex-1 flex-col @3xl:w-72 @3xl:flex-none @3xl:border-r",
						mobileDetailOpen ? "hidden @3xl:flex" : "flex",
					)}
				>
					<header className="space-y-4 border-b p-4">
						<div className="flex flex-wrap items-baseline justify-between gap-2">
							<h2 className="text-xl font-medium">
								{t("会话历史", "Conversations")}
							</h2>
							<p className="text-xs text-muted-foreground" role="status">
								{loading
									? t("加载中…", "Loading…")
									: totalCount !== null && totalCount > threads.length
										? t(
												`已加载 ${threads.length} / ${totalCount} 个`,
												`Loaded ${threads.length} of ${totalCount}`,
											)
										: t(
												`已加载 ${threads.length} 个`,
												`Loaded ${threads.length}`,
											)}
							</p>
						</div>
						<div className="space-y-1.5">
							<label
								htmlFor="archive-search"
								className="text-xs text-muted-foreground"
							>
								{t("搜索会话", "Search conversations")}
							</label>
							<div className="relative">
								<Search
									aria-hidden
									className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
								/>
								<Input
									ref={searchRef}
									id="archive-search"
									type="search"
									placeholder={t("会话标题", "Conversation title")}
									value={query}
									onChange={(event) => setQuery(event.target.value)}
									className="h-11 pl-9 md:h-9"
								/>
							</div>
						</div>
						<div className="space-y-1.5">
							<label
								htmlFor="archive-library"
								className="text-xs text-muted-foreground"
							>
								{t("知识库", "Library")}
							</label>
							<Select
								items={libraryOptions}
								value={libraryFilter}
								onValueChange={(value) => {
									if (value !== null) setLibraryFilter(value);
								}}
							>
								<SelectTrigger
									id="archive-library"
									className="h-11 w-full min-w-0 md:h-9"
								>
									<SelectValue className="min-w-0 truncate" />
								</SelectTrigger>
								<SelectContent>
									<SelectGroup>
										{libraryOptions.map((option) => (
											<SelectItem key={option.value} value={option.value}>
												{option.label}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						</div>
					</header>
					<ScrollArea className="min-h-0 flex-1">
						<div className="p-2">
							{loading ? (
								<p
									role="status"
									className="px-2 py-6 text-sm text-muted-foreground"
								>
									{t("加载会话列表…", "Loading conversations…")}
								</p>
							) : error ? (
								<div className="space-y-3 px-2 py-6">
									<p role="alert" className="text-sm text-destructive">
										{error}
									</p>
									<Button
										variant="outline"
										className="h-11"
										onClick={() => setListRetry((value) => value + 1)}
									>
										{t("重试加载列表", "Retry loading the list")}
									</Button>
								</div>
							) : threads.length === 0 && !hasActiveFilters ? (
								<div className="space-y-3 px-2 py-6">
									<p className="text-sm text-muted-foreground">
										{t("还没有归档会话", "No archived conversations yet")}
									</p>
									<Link
										href="/app/ask"
										className={cn(
											buttonVariants({ variant: "outline" }),
											"h-11",
										)}
									>
										{t("开始提问", "Ask a question")}
									</Link>
								</div>
							) : threads.length === 0 ? (
								<p
									role="status"
									className="px-2 py-6 text-sm text-muted-foreground"
								>
									{t("没有匹配的会话", "No matching conversations")}
								</p>
							) : (
								<>
									{Array.from(groups, ([label, items]) => (
										<section key={label} aria-label={label} className="mb-4">
											<h2 className="px-3 py-3 text-xs font-medium text-muted-foreground">
												{label}
											</h2>
											<ul className="space-y-1">
												{items.map((thread) => (
													<li key={thread.id}>
														<button
															type="button"
															aria-current={
																selectedId === thread.id ? "true" : undefined
															}
															onClick={(event) => {
																listTriggerRef.current = event.currentTarget;
																setSelectedId(thread.id);
																setMobileDetailOpen(true);
															}}
															className={cn(
																"min-h-11 w-full rounded-lg border-l-2 px-3 py-3 text-left transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
																selectedId === thread.id
																	? "border-evidence bg-muted"
																	: "border-transparent hover:bg-muted/60",
															)}
														>
															<span className="block text-sm font-medium leading-6 [overflow-wrap:anywhere]">
																{thread.title}
															</span>
															<span className="mt-1 block text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
																{libraryName(thread.library_id)}
															</span>
															<span className="mt-1 block text-xs leading-5 text-muted-foreground">
																{formatDateTime(thread.updated_at)} ·{" "}
																{thread.turn_count} {t("轮", "turns")}
															</span>
														</button>
													</li>
												))}
											</ul>
										</section>
									))}
									{loadMoreError ? (
										<p
											role="alert"
											className="px-2 pb-2 text-xs text-destructive"
										>
											{loadMoreError}
										</p>
									) : null}
									{hasMore ? (
										<div className="px-1 pb-2">
											<Button
												type="button"
												variant="outline"
												className="h-11 w-full"
												disabled={loadingMore}
												aria-busy={loadingMore}
												onClick={() => void loadMoreThreads()}
											>
												{loadingMore ? (
													<Loader2
														className="size-4 animate-spin motion-reduce:animate-none"
														aria-hidden
													/>
												) : null}
												{loadingMore
													? t(
															"正在加载更早会话…",
															"Loading older conversations…",
														)
													: t("加载更早会话", "Load older conversations")}
											</Button>
										</div>
									) : null}
								</>
							)}
						</div>
					</ScrollArea>
				</aside>
				<section
					aria-label={t("会话详情", "Conversation details")}
					className={cn(
						"min-h-0 min-w-0 flex-1 flex-col",
						mobileDetailOpen ? "flex" : "hidden @3xl:flex",
					)}
				>
					<div className="border-b px-3 py-2 @3xl:hidden">
						<Button
							ref={backRef}
							variant="ghost"
							className="h-11"
							onClick={returnToList}
						>
							<ArrowLeft aria-hidden />
							{t("返回会话列表", "Back to conversations")}
						</Button>
					</div>
					<ScrollArea className="min-h-0 min-w-0 flex-1">
						<div className="px-4 py-6 @3xl:px-8">
							{detailLoading ||
							(selectedId && !currentDetail && !detailError) ? (
								<p role="status" className="text-sm text-muted-foreground">
									{t("加载会话…", "Loading conversation…")}
								</p>
							) : detailError ? (
								<div className="space-y-3">
									<p role="alert" className="text-sm text-destructive">
										{detailError}
									</p>
									<Button
										variant="outline"
										className="h-11"
										onClick={() => setDetailRetry((value) => value + 1)}
									>
										{t("重试加载会话", "Retry loading conversation")}
									</Button>
								</div>
							) : currentDetail ? (
								<div className="mx-auto w-full max-w-3xl space-y-8">
									<header className="space-y-4 border-b pb-6">
										<h2 className="text-xl font-medium leading-8 [overflow-wrap:anywhere]">
											{currentDetail.title}
										</h2>
										<div className="flex flex-wrap gap-x-4 gap-y-2 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
											<time dateTime={currentDetail.updated_at}>
												{formatDateTime(currentDetail.updated_at)}
											</time>
											<span>{libraryName(currentDetail.library_id)}</span>
											<span>
												{currentDetail.turn_count} {t("轮", "turns")}
											</span>
										</div>
										<Link
											href={`/app/ask?thread=${encodeURIComponent(currentDetail.id)}`}
											className={cn(
												buttonVariants({ variant: "outline" }),
												"h-11",
											)}
										>
											<MessageSquare aria-hidden />
											{t("继续对话", "Continue conversation")}
										</Link>
									</header>
									{currentDetail.turns.length > 1 ? (
										<div className="space-y-2">
											<label
												htmlFor="archive-turn"
												className="text-xs text-muted-foreground"
											>
												{t("对话轮次", "Conversation turns")}
											</label>
											<Select
												items={turnOptions}
												value={selectedTurn?.id || ""}
												onValueChange={(value) => {
													if (value === null) return;
													setSelectedTurnId(value);
													setFocusedCitationId("");
												}}
											>
												<SelectTrigger
													id="archive-turn"
													className="min-h-11 w-full min-w-0"
												>
													<SelectValue className="min-w-0 truncate" />
												</SelectTrigger>
												<SelectContent>
													<SelectGroup>
														{turnOptions.map((option) => (
															<SelectItem
																key={option.value}
																value={option.value}
																className="min-h-11"
															>
																{option.label}
															</SelectItem>
														))}
													</SelectGroup>
												</SelectContent>
											</Select>
										</div>
									) : null}
									{selectedTurn ? (
										<div key={selectedTurn.id} className="space-y-8">
											<section
												aria-label={t("问题", "Question")}
												className="space-y-2"
											>
												<h3 className="text-xs text-muted-foreground">
													{t("问题", "Question")}
												</h3>
												<p className="whitespace-pre-wrap text-base font-medium leading-7 [overflow-wrap:anywhere]">
													{selectedTurn.question}
												</p>
											</section>
											<article
												aria-label={t("回答", "Answer")}
												className="min-w-0 [&_button]:min-h-11 [&_button]:min-w-11 [&_button]:text-xs"
											>
												<h3 className="text-xs text-muted-foreground">
													{t("回答", "Answer")}
												</h3>
												<MarkdownAnswer
													content={selectedTurn.answer}
													citations={selectedTurn.citations.map(toUiCitation)}
													enhanced
													onCite={(citation) => {
														citationTriggerRef.current =
															document.activeElement instanceof HTMLElement
																? document.activeElement
																: null;
														setFocusedCitationId(citation.id);
														const source = citationRefs.current.get(
															citation.id,
														);
														source?.focus({ preventScroll: true });
														source?.scrollIntoView({ block: "start" });
													}}
												/>
											</article>
											{selectedTurn.citations.length > 0 ? (
												<section
													aria-label={t("引用来源", "Sources")}
													className="space-y-4 border-t pt-6"
												>
													<h3 className="text-sm font-medium">
														{t("引用来源 ·", "Sources ·")}{" "}
														{selectedTurn.citations.length} {t("条", "sources")}
													</h3>
													<ul className="divide-y">
														{selectedTurn.citations.map((citation) => (
															<li
																key={citation.id}
																tabIndex={-1}
																ref={(node) => {
																	if (node)
																		citationRefs.current.set(citation.id, node);
																	else citationRefs.current.delete(citation.id);
																}}
																className="scroll-mt-4 py-5 first:pt-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
															>
																<CitationSourceCard
																	citation={toUiCitation(citation)}
																	active={focusedCitationId === citation.id}
																	expanded
																/>
																{focusedCitationId === citation.id ? (
																	<Button
																		variant="ghost"
																		className="mt-3 h-11"
																		onClick={() => {
																			if (
																				citationTriggerRef.current?.isConnected
																			)
																				citationTriggerRef.current.focus();
																		}}
																	>
																		<ArrowUp aria-hidden />
																		{t("返回回答", "Back to answer")}
																	</Button>
																) : null}
															</li>
														))}
													</ul>
												</section>
											) : null}
										</div>
									) : (
										<p className="text-sm text-muted-foreground">
											{t(
												"该会话还没有消息。",
												"This conversation has no messages yet.",
											)}
										</p>
									)}
								</div>
							) : (
								<p className="py-8 text-sm text-muted-foreground">
									{t("未选择会话", "No conversation selected")}
								</p>
							)}
						</div>
					</ScrollArea>
				</section>
			</div>
		</div>
	);
}
