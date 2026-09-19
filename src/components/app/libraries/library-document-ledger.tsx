"use client";

import { FileUp, MoreHorizontal, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { AuthButton } from "@/components/app/auth-button";
import { DocumentStatusBadge } from "@/components/app/document-status";
import {
	type DocActionContext,
	resolveDocActions,
} from "@/components/app/library-doc-actions";
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
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import type { ApiDocument, ApiLibrary } from "@/lib/api";
import type { PermissionCaps } from "@/lib/client-permissions";
import { TERMINAL_JOB_STATUSES } from "@/lib/document-lifecycle-contract";
import { formatDateTime, formatDurationMs, formatFileSize } from "@/lib/format";
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
	lastUploadMs: number | null;
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
	lastUploadMs,
	actions,
	onCreateLibrary,
	onUpload,
}: LibraryDocumentLedgerProps) {
	const [query, setQuery] = useState("");
	const filteredDocuments = useMemo(() => {
		const normalized = query.trim().toLocaleLowerCase();
		if (!normalized) return documents;
		return documents.filter((doc) =>
			`${doc.name} ${doc.filename}`.toLocaleLowerCase().includes(normalized),
		);
	}, [documents, query]);
	const summary = useMemo(
		() => ({
			ready: documents.filter((doc) => doc.status === "ready").length,
			processing: documents.filter((doc) =>
				["processing", "indexing", "queued"].includes(doc.status),
			).length,
			failed: documents.filter((doc) => doc.status === "failed").length,
			chunks: documents.reduce(
				(sum, doc) => sum + Math.max(0, doc.chunk_count || 0),
				0,
			),
		}),
		[documents],
	);

	return (
		<>
			{library ? (
				<div className="grid shrink-0 grid-cols-4 border-b border-border/70 bg-background">
					{[
						["可检索", summary.ready],
						["处理中", summary.processing],
						["需处理", summary.failed],
						["知识片段", summary.chunks],
					].map(([label, value], index) => (
						<div
							key={label}
							className={cn(
								"min-w-0 px-3 py-3 sm:px-5",
								index > 0 && "border-l border-border/60",
							)}
						>
							<p className="truncate font-mono text-[0.6875rem] text-muted-foreground sm:text-xs">
								{label}
							</p>
							<p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
								{value}
							</p>
						</div>
					))}
				</div>
			) : null}

			{pageError ? (
				<p className="text-ui mx-5 mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive">
					{pageError}
				</p>
			) : null}

			{lastUploadMs != null ? (
				<p className="text-meta mx-5 mt-2 font-mono text-muted-foreground">
					上次上传 {formatDurationMs(lastUploadMs)}
				</p>
			) : null}

			<div className="min-h-0 flex-1 px-4 py-4 sm:px-5">
				{library && documents.length > 0 ? (
					<div className="mb-3 flex flex-wrap items-end justify-between gap-3">
						<div>
							<p className="text-sm font-medium text-foreground">文档台账</p>
							<p className="text-meta mt-0.5 font-mono text-muted-foreground">
								显示 {filteredDocuments.length} / {documents.length} 份文档
							</p>
						</div>
						<div className="relative w-full sm:w-72">
							<Search
								className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
								aria-hidden
							/>
							<Input
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder="搜索显示名或原文件…"
								className="h-9 rounded-md pl-8"
								aria-label="搜索文档"
							/>
						</div>
					</div>
				) : null}

				{!library ? (
					<div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border/80 bg-muted/20 px-6 text-center">
						<p className="text-ui text-muted-foreground">
							{canManageLibraries
								? "还没有知识库"
								: "当前 Workspace 还没有知识库"}
						</p>
						<AuthButton
							cap="manageLibraries"
							type="button"
							className="hidden rounded-md md:inline-flex"
							disabled={savingLibrary}
							onClick={onCreateLibrary}
						>
							<Plus data-icon="inline-start" />
							新建知识库
						</AuthButton>
					</div>
				) : documents.length === 0 ? (
					<div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border/80 bg-muted/20 px-6 text-center">
						<p className="text-ui text-muted-foreground">
							{canWriteLibraries
								? "尚无文档。上传后即可在问答中引用。"
								: "尚无文档。当前角色为只读，请联系编辑者或管理员上传。"}
						</p>
						<AuthButton
							cap="writeLibraries"
							type="button"
							className="rounded-md"
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
						<p className="text-ui mt-1 text-muted-foreground">
							换一个名称或文件名关键词试试。
						</p>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="mt-2"
							onClick={() => setQuery("")}
						>
							清除搜索
						</Button>
					</div>
				) : (
					<div className="max-w-full overflow-x-auto rounded-md border border-border/80">
						<Table className="table-fixed md:table-auto">
							<TableHeader>
								<TableRow className="hover:bg-transparent">
									<TableHead>显示名</TableHead>
									<TableHead className="hidden md:table-cell">原文件</TableHead>
									<TableHead className="w-24 md:w-auto">状态</TableHead>
									<TableHead className="hidden text-right md:table-cell">
										大小
									</TableHead>
									<TableHead className="hidden text-right md:table-cell">
										Chunks
									</TableHead>
									<TableHead className="hidden md:table-cell">
										更新时间
									</TableHead>
									<TableHead className="w-12 text-right">操作</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{filteredDocuments.map((doc) => {
									const busy = busyDocId === doc.id;
									const actionContext: DocActionContext = {
										busy,
										processing: doc.status === "processing",
										...actions,
									};
									return (
										<TableRow key={doc.id}>
											<TableCell className="max-w-50">
												<button
													type="button"
													className="block max-w-full truncate text-left font-medium hover:text-cite focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
													onClick={() => actions.onView(doc)}
												>
													{doc.name}
												</button>
											</TableCell>
											<TableCell className="hidden max-w-40 md:table-cell">
												<span className="text-meta block truncate font-mono text-muted-foreground">
													{doc.filename}
												</span>
											</TableCell>
											<TableCell className="w-24 md:w-auto">
												<DocumentStatusBadge
													status={doc.status}
													parserReport={doc.parser_report}
												/>
												{doc.job_stage &&
												doc.job_status &&
												!TERMINAL_JOB_STATUSES.has(doc.job_status) ? (
													<span className="text-meta mt-1 block font-mono text-muted-foreground">
														{doc.job_stage}
														{doc.job_progress != null
															? ` · ${doc.job_progress}%`
															: ""}
													</span>
												) : null}
											</TableCell>
											<TableCell className="hidden text-right font-mono text-meta text-muted-foreground md:table-cell">
												{formatFileSize(doc.size_bytes)}
											</TableCell>
											<TableCell className="hidden text-right font-mono text-meta md:table-cell">
												{doc.chunk_count}
											</TableCell>
											<TableCell className="hidden text-meta font-mono text-muted-foreground md:table-cell">
												{formatDateTime(doc.updated_at)}
											</TableCell>
											<TableCell className="text-right">
												<DropdownMenu>
													<DropdownMenuTrigger
														render={
															<Button
																variant="ghost"
																size="icon-sm"
																className="rounded-md"
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
