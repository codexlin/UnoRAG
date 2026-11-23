"use client";

import {
	FileText,
	FileUp,
	Loader2,
	MoreHorizontal,
	Plus,
	RotateCcw,
	Search,
} from "lucide-react";
import { useMemo, useState } from "react";
import { AuthButton } from "@/components/app/auth-button";
import { LedgerTable } from "@/components/app/ledger-table";
import {
	type DocActionContext,
	resolveDocActions,
} from "@/components/app/library-doc-actions";
import { stageDisplayName } from "@/components/app/stage-waterfall";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	TableBody,
	TableCell,
	TableHead,
	TableRow,
} from "@/components/ui/table";
import type { ApiDocument, ApiLibrary } from "@/lib/api";
import type { PermissionCaps } from "@/lib/client-permissions";
import { documentProcessingView } from "@/lib/document-processing-view";
import { formatDateTime, formatFileSize } from "@/lib/format";
import { useInterfaceLanguage, useInterfaceText } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

export type DocumentLedgerActions = Omit<
	DocActionContext,
	"busy" | "processing"
>;

type LibraryDocumentLedgerProps = {
	library: ApiLibrary | null;
	documents: ApiDocument[];
	caps: PermissionCaps;
	canManageLibraries: boolean;
	canWriteLibraries: boolean;
	savingLibrary: boolean;
	uploadDisabled: boolean;
	busyDocId: string | null;
	pageError: string | null;
	loading: boolean;
	loadError: string | null;
	libraryLoadError: string | null;
	refreshing: boolean;
	onRetryLoad: () => void;
	actions: DocumentLedgerActions;
	onCreateLibrary: () => void;
	onUpload: () => void;
};

export function LibraryDocumentLedger({
	library,
	documents,
	caps,
	canManageLibraries,
	canWriteLibraries,
	savingLibrary,
	uploadDisabled,
	busyDocId,
	pageError,
	loading,
	loadError,
	libraryLoadError,
	refreshing,
	onRetryLoad,
	actions,
	onCreateLibrary,
	onUpload,
}: LibraryDocumentLedgerProps) {
	const t = useInterfaceText();
	const { locale } = useInterfaceLanguage();
	const taskFilterOptions = [
		{ value: "all", label: t("全部任务", "All jobs") },
		{ value: "processing", label: t("任务处理中", "Active jobs") },
		{ value: "failed", label: t("任务失败", "Failed jobs") },
	];
	const [query, setQuery] = useState("");
	const [taskFilter, setTaskFilter] = useState("all");
	const filteredDocuments = useMemo(() => {
		const normalized = query.trim().toLocaleLowerCase();
		return documents.filter((doc) => {
			const task = documentProcessingView(doc);
			return (
				`${doc.name} ${doc.filename}`
					.toLocaleLowerCase()
					.includes(normalized) &&
				(taskFilter === "all" ||
					(taskFilter === "processing" && task.processing) ||
					(taskFilter === "failed" && task.failed))
			);
		});
	}, [documents, query, taskFilter]);
	const summary = useMemo(
		() => ({
			completed: documents.filter(
				(doc) => documentProcessingView(doc).completed,
			).length,
			processing: documents.filter(
				(doc) => documentProcessingView(doc).processing,
			).length,
			failed: documents.filter((doc) => documentProcessingView(doc).failed)
				.length,
		}),
		[documents],
	);

	return (
		<>
			{library ? (
				<section
					aria-label={t("文档与任务统计", "Document and job totals")}
					className="grid shrink-0 grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] border-b border-border/70 bg-background"
				>
					{[
						[t("文档", "Documents"), documents.length],
						[t("任务完成", "Completed jobs"), summary.completed],
						[t("任务处理中", "Active jobs"), summary.processing],
						[t("任务失败", "Failed jobs"), summary.failed],
					].map(([label, value], index) => (
						<div
							key={label}
							className={cn(
								"min-w-0 px-3 py-3 sm:px-5",
								index > 0 && "border-l border-border/60",
							)}
						>
							<p className="break-words text-xs text-muted-foreground">
								{label}
							</p>
							<p className="mt-1 text-lg font-medium tabular-nums text-foreground">
								{loading || (loadError && documents.length === 0)
									? "--"
									: value}
							</p>
						</div>
					))}
				</section>
			) : null}

			{pageError ? (
				<p
					role="alert"
					className="mx-5 mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
				>
					{pageError}
				</p>
			) : null}

			<div className="flex min-h-0 flex-1 flex-col px-4 py-5 sm:px-6 md:overflow-hidden">
				{library && documents.length > 0 ? (
					<div className="mb-3 flex shrink-0 flex-wrap items-end justify-between gap-3">
						<div>
							<p className="text-sm font-medium text-foreground">
								{t("文档", "Documents")}
							</p>
							<p className="mt-1 text-xs text-muted-foreground">
								{t("显示", "Showing")} {filteredDocuments.length} /{" "}
								{documents.length} {t("份文档", "documents")}
							</p>
						</div>
						<div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
							<label className="sr-only" htmlFor="document-task-filter">
								{t("最近处理任务", "Recent jobs")}
							</label>
							<Select
								items={taskFilterOptions}
								value={taskFilter}
								onValueChange={(value) => {
									if (value !== null) setTaskFilter(value);
								}}
							>
								<SelectTrigger
									id="document-task-filter"
									className="h-11 min-w-0 md:h-9"
								>
									<SelectValue className="min-w-0 truncate" />
								</SelectTrigger>
								<SelectContent>
									<SelectGroup>
										{taskFilterOptions.map((option) => (
											<SelectItem key={option.value} value={option.value}>
												{option.label}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
							<div className="relative min-w-[min(100%,12rem)] flex-1 sm:w-64">
								<Search
									className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
									aria-hidden
								/>
								<Input
									value={query}
									onChange={(event) => setQuery(event.target.value)}
									placeholder={t(
										"搜索显示名或原文件…",
										"Search by display name or original file…",
									)}
									className="h-11 rounded-md pl-8 md:h-9"
									aria-label={t("搜索文档", "Search documents")}
								/>
							</div>
						</div>
					</div>
				) : null}

				{loading ? (
					<div
						role="status"
						className="flex min-h-60 items-center justify-center gap-2 text-sm text-muted-foreground"
					>
						<Loader2
							className="size-4 animate-spin motion-reduce:animate-none"
							aria-hidden
						/>
						{library
							? t("正在加载文档…", "Loading documents…")
							: t("正在加载知识库…", "Loading libraries…")}
					</div>
				) : (!library && libraryLoadError) ||
					(library && loadError && documents.length === 0) ? (
					<div className="flex min-h-60 flex-col items-center justify-center gap-3 text-sm">
						<p className="text-muted-foreground">
							{library
								? t(
										"文档列表未能加载，暂无法确认资料数量。",
										"Couldn't load documents or verify the document count.",
									)
								: t(
										"知识库列表未能加载，暂无法确认资料数量。",
										"Couldn't load libraries or verify the document count.",
									)}
						</p>
						<Button
							type="button"
							variant="outline"
							className="h-11"
							onClick={onRetryLoad}
							disabled={refreshing}
							aria-busy={refreshing}
						>
							<RotateCcw data-icon="inline-start" aria-hidden />
							{library
								? t("重试加载文档", "Retry loading documents")
								: t("重试加载知识库", "Retry loading libraries")}
						</Button>
					</div>
				) : !library ? (
					<div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border/80 bg-muted/20 px-6 text-center">
						<p className="text-sm text-muted-foreground">
							{canManageLibraries
								? t("还没有知识库", "No libraries yet")
								: t(
										"当前 Workspace 还没有知识库",
										"This workspace has no libraries.",
									)}
						</p>
						<AuthButton
							cap="manageLibraries"
							type="button"
							className="hidden h-11 min-w-11 rounded-md md:inline-flex"
							disabled={savingLibrary}
							onClick={onCreateLibrary}
						>
							<Plus data-icon="inline-start" />
							{t("新建知识库", "Create library")}
						</AuthButton>
					</div>
				) : documents.length === 0 ? (
					<div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border/80 bg-muted/20 px-6 text-center">
						<p className="text-sm text-muted-foreground">
							{canWriteLibraries
								? t("尚无文档", "No documents yet")
								: t(
										"尚无文档。当前角色为只读，请联系编辑者或管理员上传。",
										"No documents. Ask an editor or administrator to upload one.",
									)}
						</p>
						<AuthButton
							cap="writeLibraries"
							type="button"
							className="h-11 min-w-11 rounded-md"
							disabled={uploadDisabled}
							onClick={onUpload}
						>
							<FileUp data-icon="inline-start" />
							{t("上传文档", "Upload documents")}
						</AuthButton>
					</div>
				) : filteredDocuments.length === 0 ? (
					<div className="flex min-h-48 flex-col items-center justify-center border border-dashed border-border/80 bg-muted/20 px-6 text-center">
						<p className="text-sm font-medium text-foreground">
							{t("没有匹配的文档", "No matching documents")}
						</p>
						<p className="mt-1 text-sm text-muted-foreground">
							{t(
								"换一个名称或文件名关键词试试。",
								"Try another name or filename.",
							)}
						</p>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="mt-2 h-11"
							onClick={() => {
								setQuery("");
								setTaskFilter("all");
							}}
						>
							{t("清除筛选", "Clear filters")}
						</Button>
					</div>
				) : (
					<LedgerTable
						className="table-fixed"
						header={
							<TableRow className="hover:bg-transparent">
								<TableHead className="w-[44%] 2xl:w-[32%]">
									{t("文档名称", "Document name")}
								</TableHead>
								<TableHead className="hidden 2xl:table-cell 2xl:w-[16%]">
									{t("原文件", "Original file")}
								</TableHead>
								<TableHead className="w-24 md:w-28">
									{t("最近处理", "Latest job")}
								</TableHead>
								<TableHead className="hidden w-20 text-right xl:table-cell">
									{t("大小", "Size")}
								</TableHead>
								<TableHead
									className="hidden w-20 text-right xl:table-cell"
									title={t("本次生效片段数", "Chunks in this version")}
								>
									{t("片段", "Chunks")}
								</TableHead>
								<TableHead className="hidden w-36 lg:table-cell">
									{t("更新时间", "Updated")}
								</TableHead>
								<TableHead className="w-14 text-right">
									{t("操作", "Actions")}
								</TableHead>
							</TableRow>
						}
					>
						<TableBody>
							{filteredDocuments.map((doc) => {
								const busy = busyDocId === doc.id;
								const task = documentProcessingView(doc, locale);
								const actionContext: DocActionContext = {
									busy,
									processing: doc.status === "processing",
									...actions,
								};
								return (
									<TableRow key={doc.id}>
										<TableCell className="py-2.5 whitespace-normal">
											<button
												type="button"
												className="flex min-h-11 w-full min-w-0 items-center gap-2.5 text-left font-medium hover:text-evidence focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-9"
												aria-label={doc.name}
												onClick={() => actions.onView(doc)}
											>
												<FileText
													className="hidden size-4 shrink-0 text-muted-foreground sm:block"
													aria-hidden
												/>
												<span className="min-w-0">
													<span
														className="line-clamp-2 [overflow-wrap:anywhere]"
														title={doc.name}
													>
														{doc.name}
													</span>
													{doc.filename !== doc.name ? (
														<span
															className="mt-0.5 block truncate text-xs font-normal text-muted-foreground 2xl:hidden"
															title={doc.filename}
														>
															{doc.filename}
														</span>
													) : null}
												</span>
											</button>
										</TableCell>
										<TableCell className="hidden 2xl:table-cell">
											<span className="text-meta block truncate text-muted-foreground">
												{doc.filename}
											</span>
										</TableCell>
										<TableCell>
											<span
												className={cn(
													"text-sm",
													task.failed
														? "text-destructive"
														: task.processing
															? "text-warning-foreground"
															: task.completed
																? "text-cite"
																: "text-muted-foreground",
												)}
											>
												{task.label}
											</span>
											{task.stage ? (
												<span className="mt-0.5 block break-words text-xs text-muted-foreground">
													{stageDisplayName(task.stage, locale)}
												</span>
											) : null}
											{doc.status === "degraded" ? (
												<span className="mt-0.5 block text-xs text-warning-foreground">
													{t("解析降级", "Parsing fallback")}
												</span>
											) : null}
										</TableCell>
										<TableCell className="hidden text-right font-mono text-meta tabular-nums text-muted-foreground xl:table-cell">
											{formatFileSize(doc.size_bytes)}
										</TableCell>
										<TableCell className="hidden text-right font-mono text-meta tabular-nums xl:table-cell">
											{task.completed ||
											["ready", "degraded"].includes(doc.status)
												? doc.chunk_count
												: "—"}
										</TableCell>
										<TableCell className="hidden font-mono text-meta tabular-nums text-muted-foreground lg:table-cell">
											{formatDateTime(doc.updated_at)}
										</TableCell>
										<TableCell className="text-right">
											<DropdownMenu>
												<DropdownMenuTrigger
													render={
														<Button
															variant="ghost"
															size="icon"
															className="size-11 rounded-md md:size-9"
															disabled={busy}
														/>
													}
												>
													<MoreHorizontal />
													<span className="sr-only">
														{t("操作", "Actions")}
													</span>
												</DropdownMenuTrigger>
												<DropdownMenuContent align="end" className="min-w-40">
													{resolveDocActions(caps, doc).map((action) => {
														const Icon = action.icon;
														return (
															<div key={action.id}>
																{action.separatorBefore ? (
																	<DropdownMenuSeparator />
																) : null}
																<DropdownMenuItem
																	variant={
																		action.destructive
																			? "destructive"
																			: undefined
																	}
																	disabled={
																		action.disabled?.(doc, actionContext) ??
																		false
																	}
																	onClick={() => action.run(doc, actionContext)}
																>
																	<Icon />
																	{t(...action.label)}
																</DropdownMenuItem>
															</div>
														);
													})}
												</DropdownMenuContent>
											</DropdownMenu>
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</LedgerTable>
				)}
			</div>
		</>
	);
}
