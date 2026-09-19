"use client";

import {
	FileUp,
	MessageSquareText,
	Pencil,
	RefreshCw,
	Settings2,
	Trash2,
} from "lucide-react";
import Link from "next/link";

import { AuthButton } from "@/components/app/auth-button";
import { Can } from "@/components/app/can";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ApiLibrary } from "@/lib/api";
import {
	ASK_LIBRARY_STORAGE_KEY,
	isAskableLibrary,
} from "@/lib/ask-library-selection.mjs";
import { cn } from "@/lib/utils";

const DOCUMENT_PROFILE_LABELS: Record<string, string> = {
	auto: "自动",
	general: "通用",
	narrative: "长文",
	table_heavy: "表格",
	regulatory: "制度",
	precise_paragraph: "段落",
};

const PARSE_PREFERENCE_LABELS: Record<string, string> = {
	auto: "自动",
	quality: "高质量",
	local_only: "本地",
};

type LibraryWorkspaceHeaderProps = {
	library: ApiLibrary | null;
	documentCount: number;
	canManageLibraries: boolean;
	uploading: boolean;
	uploadDisabled: boolean;
	refreshing: boolean;
	saving: boolean;
	deleting: boolean;
	onUpload: () => void;
	onRefresh: () => void;
	onEdit: (library: ApiLibrary) => void;
	onDelete: (library: ApiLibrary) => void;
};

export function LibraryWorkspaceHeader({
	library,
	documentCount,
	canManageLibraries,
	uploading,
	uploadDisabled,
	refreshing,
	saving,
	deleting,
	onUpload,
	onRefresh,
	onEdit,
	onDelete,
}: LibraryWorkspaceHeaderProps) {
	return (
		<div
			className={cn(
				"flex flex-wrap items-start justify-between gap-3 border-b border-border/70 bg-card px-4 py-3 sm:gap-4 sm:px-5 sm:py-4",
				!library && "hidden md:flex",
			)}
		>
			<div className="min-w-0 space-y-1">
				<p className="text-meta hidden font-mono tracking-[0.14em] text-cite uppercase md:block">
					Library workspace
				</p>
				<h3 className="font-heading truncate text-xl font-semibold">
					<span className="md:hidden">{library ? "文档" : "知识库"}</span>
					<span className="hidden md:inline">
						{library?.name ?? "选择知识库"}
					</span>
				</h3>
				{library?.description?.trim() ? (
					<p className="text-ui hidden truncate text-muted-foreground md:block">
						{library.description.trim()}
					</p>
				) : null}
				{library ? (
					<div className="flex flex-wrap gap-1.5 pt-1">
						<span className="meta-chip">
							{DOCUMENT_PROFILE_LABELS[library.document_profile || "auto"] ??
								library.document_profile}{" "}
							分块
						</span>
						<span className="meta-chip">
							{PARSE_PREFERENCE_LABELS[library.parse_preference || "auto"] ??
								library.parse_preference}{" "}
							解析
						</span>
						{library.requires_reindex ? (
							<span className="meta-chip border-survey/35 bg-accent text-accent-foreground">
								需要重索引
							</span>
						) : null}
					</div>
				) : (
					<p className="text-ui hidden text-muted-foreground md:block">
						{canManageLibraries
							? "从左侧选择或新建知识库。"
							: "从左侧选择知识库。"}
					</p>
				)}
			</div>
			{library ? (
				<div
					className={cn(
						"flex flex-wrap items-center gap-2",
						documentCount > 0 ? "w-full sm:w-auto" : "w-auto",
					)}
				>
					{documentCount > 0 ? (
						<>
							{isAskableLibrary(library) ? (
								<Link
									href="/app/ask"
									onClick={() => {
										try {
											window.localStorage.setItem(
												ASK_LIBRARY_STORAGE_KEY,
												library.id,
											);
										} catch {
											// Navigation remains usable in hardened browser contexts.
										}
									}}
									className={cn(
										buttonVariants({ variant: "outline" }),
										"h-10 min-w-0 flex-1 rounded-md sm:h-9 sm:flex-none",
									)}
								>
									<MessageSquareText data-icon="inline-start" />
									开始提问
								</Link>
							) : (
								<Button
									type="button"
									variant="outline"
									className="h-10 min-w-0 flex-1 rounded-md sm:h-9 sm:flex-none"
									disabled
									title="暂无可检索文档"
								>
									<MessageSquareText data-icon="inline-start" />
									开始提问
								</Button>
							)}
							<AuthButton
								cap="writeLibraries"
								type="button"
								className="h-10 min-w-0 flex-1 rounded-md sm:h-9 sm:flex-none"
								disabled={uploadDisabled}
								onClick={onUpload}
							>
								<FileUp data-icon="inline-start" />
								{uploading ? "上传中…" : "上传文档"}
							</AuthButton>
							<Button
								type="button"
								variant="outline"
								size="icon-sm"
								className="size-10 rounded-md sm:size-8"
								disabled={refreshing}
								onClick={onRefresh}
							>
								<RefreshCw />
								<span className="sr-only">刷新文档</span>
							</Button>
						</>
					) : null}
					<Can cap="manageLibraries">
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										type="button"
										variant="outline"
										size="icon-sm"
										className="size-10 rounded-md sm:size-8"
										disabled={saving || deleting}
									/>
								}
							>
								<Settings2 />
								<span className="sr-only">知识库设置</span>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="min-w-40">
								<DropdownMenuItem onClick={() => onEdit(library)}>
									<Pencil />
									编辑设置
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									variant="destructive"
									onClick={() => onDelete(library)}
								>
									<Trash2 />
									删除知识库
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</Can>
				</div>
			) : null}
		</div>
	);
}
