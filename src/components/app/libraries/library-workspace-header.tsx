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
import { useInterfaceText } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

type Copy = readonly [zh: string, en: string];

const DOCUMENT_PROFILE_LABELS: Record<string, Copy> = {
	auto: ["自动", "Auto"],
	general: ["通用", "General"],
	narrative: ["长文", "Long-form"],
	table_heavy: ["表格", "Table-heavy"],
	regulatory: ["制度", "Policies"],
	precise_paragraph: ["段落", "Precise paragraphs"],
};

const PARSE_PREFERENCE_LABELS: Record<string, Copy> = {
	auto: ["自动", "Auto"],
	quality: ["高质量", "High quality"],
	local_only: ["本地", "Local only"],
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
	const t = useInterfaceText();
	const profileKey = library?.document_profile || "auto";
	const parserKey = library?.parse_preference || "auto";
	const profile = Object.hasOwn(DOCUMENT_PROFILE_LABELS, profileKey)
		? DOCUMENT_PROFILE_LABELS[profileKey]
		: undefined;
	const parser = Object.hasOwn(PARSE_PREFERENCE_LABELS, parserKey)
		? PARSE_PREFERENCE_LABELS[parserKey]
		: undefined;
	return (
		<div
			className={cn(
				"flex flex-wrap items-start justify-between gap-4 border-b bg-background px-4 py-5 sm:px-6 sm:py-6",
				!library && "hidden md:flex",
			)}
		>
			<div className="min-w-0 space-y-1">
				<h3 className="font-heading truncate text-xl font-medium">
					<span className="md:hidden">
						{library ? t("文档", "Documents") : t("知识库", "Library")}
					</span>
					<span className="hidden md:inline">
						{library?.name ?? t("选择知识库", "Select a library")}
					</span>
				</h3>
				{library?.description?.trim() ? (
					<p className="hidden truncate text-sm text-muted-foreground md:block">
						{library.description.trim()}
					</p>
				) : null}
				{library ? (
					<div className="flex flex-wrap gap-1.5 pt-1">
						<span className="meta-chip">
							{profile ? t(...profile) : library.document_profile}{" "}
							{t("分块", "Chunking")}
						</span>
						<span className="meta-chip">
							{parser ? t(...parser) : library.parse_preference}{" "}
							{t("解析", "Parsing")}
						</span>
						{library.requires_reindex ? (
							<span className="meta-chip border-survey/35 bg-warning text-warning-foreground">
								{t("需要重索引", "Reindex required")}
							</span>
						) : null}
					</div>
				) : (
					<p className="hidden text-sm text-muted-foreground md:block">
						{canManageLibraries
							? t("从左侧选择或新建知识库。", "Choose or create a library.")
							: t("从左侧选择知识库。", "Choose a library.")}
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
										"h-11 flex-1 rounded-md sm:flex-none",
									)}
								>
									<MessageSquareText data-icon="inline-start" />
									{t("开始提问", "Ask a question")}
								</Link>
							) : (
								<Button
									type="button"
									variant="outline"
									className="h-11 flex-1 rounded-md sm:flex-none"
									disabled
									title={t("暂无可检索文档", "No searchable documents")}
								>
									<MessageSquareText data-icon="inline-start" />
									{t("开始提问", "Ask a question")}
								</Button>
							)}
							<AuthButton
								cap="writeLibraries"
								type="button"
								className="h-11 flex-1 rounded-md sm:flex-none"
								disabled={uploadDisabled}
								onClick={onUpload}
							>
								<FileUp data-icon="inline-start" />
								{uploading
									? t("上传中…", "Uploading…")
									: t("上传文档", "Upload documents")}
							</AuthButton>
							<Button
								type="button"
								variant="outline"
								size="icon-sm"
								className="size-11 rounded-md"
								disabled={refreshing}
								onClick={onRefresh}
							>
								<RefreshCw />
								<span className="sr-only">
									{t("刷新文档", "Refresh documents")}
								</span>
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
										className="size-11 rounded-md"
										disabled={saving || deleting}
									/>
								}
							>
								<Settings2 />
								<span className="sr-only">
									{t("知识库设置", "Library settings")}
								</span>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="min-w-40">
								<DropdownMenuItem
									disabled={library.status === "deleting"}
									onClick={() => onEdit(library)}
								>
									<Pencil />
									{t("编辑设置", "Edit settings")}
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									variant="destructive"
									disabled={library.status === "deleting"}
									onClick={() => onDelete(library)}
								>
									<Trash2 />
									{t("删除知识库", "Delete library")}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</Can>
				</div>
			) : null}
		</div>
	);
}
