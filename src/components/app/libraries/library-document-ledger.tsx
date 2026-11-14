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
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import type { ApiDocument, ApiLibrary } from "@/lib/api";
import type { PermissionCaps } from "@/lib/client-permissions";
import { documentProcessingView } from "@/lib/document-processing-view";
import { formatDateTime, formatFileSize } from "@/lib/format";
import { cn } from "@/lib/utils";

const TASK_FILTER_OPTIONS = [
	{ value: "all", label: "全部任务" },
	{ value: "processing", label: "任务处理中" },
	{ value: "failed", label: "任务失败" },
];

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
					aria-label="文档与任务统计"
					className="grid shrink-0 grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] border-b border-border/70 bg-background"
				>
					{[
						["文档", documents.length],
						["任务完成", summary.completed],
						["任务处理中", summary.processing],
						["任务失败", summary.failed],
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

			<div className="min-h-0 flex-1 px-4 py-5 sm:px-6">
				{library && documents.length > 0 ? (
					<div className="mb-3 flex flex-wrap items-end justify-between gap-3">
						<div>
							<p className="text-sm font-medium text-foreground">文档</p>
							<p className="mt-1 text-xs text-muted-foreground">
								显示 {filteredDocuments.length} / {documents.length} 份文档
							</p>
						</div>
						<div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
							<label className="sr-only" htmlFor="document-task-filter">
								最近处理任务
							</label>
							<Select
								items={TASK_FILTER_OPTIONS}
								value={taskFilter}
								onValueChange={(value) => {
									if (value !== null) setTaskFilter(value);
								}}
							>
								<SelectTrigger
									id="document-task-filter"
									className="min-h-11 min-w-0"
								>
									<SelectValue className="min-w-0 truncate" />
								</SelectTrigger>
								<SelectContent>
									<SelectGroup>
										{TASK_FILTER_OPTIONS.map((option) => (
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
							<div className="relative min-w-[min(100%,12rem)] flex-1 sm:w-64">
								<Search
									className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
									aria-hidden
								/>
								<Input
									value={query}
									onChange={(event) => setQuery(event.target.value)}
									placeholder="搜索显示名或原文件…"
									className="h-11 rounded-md pl-8"
									aria-label="搜索文档"
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
						{library ? "正在加载文档…" : "正在加载知识库…"}
					</div>
				) : (!library && libraryLoadError) ||
					(library && loadError && documents.length === 0) ? (
					<div className="flex min-h-60 flex-col items-center justify-center gap-3 text-sm">
						<p className="text-muted-foreground">
							{library
								? "文档列表未能加载，暂无法确认资料数量。"
								: "知识库列表未能加载，暂无法确认资料数量。"}
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
							{library ? "重试加载文档" : "重试加载知识库"}
						</Button>
					</div>
				) : !library ? (
					<div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border/80 bg-muted/20 px-6 text-center">
						<p className="text-sm text-muted-foreground">
							{canManageLibraries
								? "还没有知识库"
								: "当前 Workspace 还没有知识库"}
						</p>
						<AuthButton
							cap="manageLibraries"
							type="button"
							className="hidden h-11 min-w-11 rounded-md md:inline-flex"
							disabled={savingLibrary}
							onClick={onCreateLibrary}
						>
							<Plus data-icon="inline-start" />
							新建知识库
						</AuthButton>
					</div>
				) : documents.length === 0 ? (
					<div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border/80 bg-muted/20 px-6 text-center">
						<p className="text-sm text-muted-foreground">
							{canWriteLibraries
								? "尚无文档"
								: "尚无文档。当前角色为只读，请联系编辑者或管理员上传。"}
						</p>
						<AuthButton
							cap="writeLibraries"
							type="button"
							className="h-11 min-w-11 rounded-md"
							disabled={uploadDisabled}
							onClick={onUpload}
						>
							<FileUp data-icon="inline-start" />
							上传文档
						</AuthButton>
					</div>
				) : filteredDocuments.length === 0 ? (
					<div className="flex min-h-48 flex-col items-center justify-center border border-dashed border-border/80 bg-muted/20 px-6 text-center">
						<p className="text-sm font-medium text-foreground">
							没有匹配的文档
						</p>
						<p className="mt-1 text-sm text-muted-foreground">
							换一个名称或文件名关键词试试。
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
							清除筛选
						</Button>
					</div>
				) : (
					<div className="max-w-full overflow-x-auto border-y border-border/80">
						<Table className="table-fixed xl:table-auto">
							<TableHeader>
								<TableRow className="hover:bg-transparent">
									<TableHead>文档名称</TableHead>
									<TableHead className="hidden xl:table-cell">原文件</TableHead>
									<TableHead className="w-24 md:w-auto">最近处理</TableHead>
									<TableHead className="hidden text-right xl:table-cell">
										大小
									</TableHead>
									<TableHead className="hidden text-right xl:table-cell">
										本次片段
									</TableHead>
									<TableHead className="hidden lg:table-cell">
										更新时间
									</TableHead>
									<TableHead className="w-16 text-right">操作</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{filteredDocuments.map((doc) => {
									const busy = busyDocId === doc.id;
									const task = documentProcessingView(doc);
									const actionContext: DocActionContext = {
										busy,
										processing: doc.status === "processing",
										...actions,
									};
									return (
										<TableRow key={doc.id}>
											<TableCell className="max-w-64 py-3">
												<button
													type="button"
													className="flex min-h-11 w-full min-w-0 items-center gap-2.5 text-left font-medium hover:text-evidence focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
																className="mt-1 block truncate text-xs font-normal text-muted-foreground xl:hidden"
																title={doc.filename}
															>
																{doc.filename}
															</span>
														) : null}
													</span>
												</button>
											</TableCell>
											<TableCell className="hidden max-w-40 xl:table-cell">
												<span className="text-meta block truncate text-muted-foreground">
													{doc.filename}
												</span>
											</TableCell>
											<TableCell className="w-24 md:w-auto">
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
													<span className="mt-1 block break-words text-xs text-muted-foreground">
														{stageDisplayName(task.stage)}
													</span>
												) : null}
												{doc.status === "degraded" ? (
													<span className="mt-1 block text-xs text-warning-foreground">
														解析降级
													</span>
												) : null}
											</TableCell>
											<TableCell className="hidden text-right font-mono text-meta text-muted-foreground xl:table-cell">
												{formatFileSize(doc.size_bytes)}
											</TableCell>
											<TableCell className="hidden text-right font-mono text-meta xl:table-cell">
												{task.completed ||
												["ready", "degraded"].includes(doc.status)
													? doc.chunk_count
													: "—"}
											</TableCell>
											<TableCell className="hidden text-meta font-mono text-muted-foreground lg:table-cell">
												{formatDateTime(doc.updated_at)}
											</TableCell>
											<TableCell className="w-16 text-right">
												<DropdownMenu>
													<DropdownMenuTrigger
														render={
															<Button
																variant="ghost"
																size="icon-sm"
																className="size-11 rounded-md"
																disabled={busy}
															/>
														}
													>
														<MoreHorizontal />
														<span className="sr-only">操作</span>
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
																		onClick={() =>
																			action.run(doc, actionContext)
																		}
																	>
																		<Icon />
																		{action.label}
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
						</Table>
					</div>
				)}
			</div>
		</>
	);
}
