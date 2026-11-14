"use client";

import {
	Archive,
	ChevronRight,
	PanelRightClose,
	PanelRightOpen,
} from "lucide-react";
import Link from "next/link";

import { LibraryCombobox } from "@/components/app/library-combobox";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ApiLibrary } from "@/lib/api";
import { cn } from "@/lib/utils";

type AskWorkspaceHeaderProps = {
	archiving: boolean;
	canArchive: boolean;
	drawerOpen: boolean;
	isArchived: boolean;
	libraries: ApiLibrary[];
	library: ApiLibrary | null;
	libraryId: string;
	onArchive: () => void;
	onDrawerOpenChange: (open: boolean) => void;
	onLibraryChange: (libraryId: string) => void;
	threadTitle: string | null;
	turnCount: number;
};

export function AskWorkspaceHeader({
	archiving,
	canArchive,
	drawerOpen,
	isArchived,
	libraries,
	library,
	libraryId,
	onArchive,
	onDrawerOpenChange,
	onLibraryChange,
	threadTitle,
	turnCount,
}: AskWorkspaceHeaderProps) {
	return (
		<div className="flex min-h-16 shrink-0 flex-wrap items-center gap-2 border-b bg-background px-4 py-2 sm:gap-3 sm:px-6">
			<div className="min-w-[min(100%,12rem)] flex-1 sm:max-w-xs">
				<LibraryCombobox
					libraries={libraries}
					value={libraryId}
					onValueChange={onLibraryChange}
					showLabel={false}
					className="w-full"
				/>
			</div>

			<Separator orientation="vertical" className="hidden h-6 sm:block" />

			<div className="hidden min-w-0 items-center gap-2.5 text-xs text-muted-foreground xl:flex">
				{libraries.length === 0 ? (
					<Link
						href="/app/libraries"
						className="inline-flex items-center gap-1 font-medium text-evidence underline-offset-4 hover:underline"
					>
						创建知识库
						<ChevronRight className="size-3.5" />
					</Link>
				) : !library ? (
					<span>请选择知识库</span>
				) : library.doc_count === 0 || library.status === "empty" ? (
					<Link
						href="/app/libraries"
						className="inline-flex items-center gap-1 font-medium text-evidence underline-offset-4 hover:underline"
					>
						知识库为空，上传文档
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
						<span>可检索文档</span>
					</span>
				)}
				<span className="text-border" aria-hidden>
					|
				</span>
				<span className="inline-flex items-center gap-1 tabular-nums">
					<span className="text-foreground/80">{turnCount}</span>
					<span>问</span>
				</span>
				{isArchived ? (
					<>
						<span className="text-border" aria-hidden>
							|
						</span>
						<span className="truncate text-evidence" title={threadTitle || ""}>
							已归档
							{threadTitle ? ` · ${threadTitle}` : ""}
						</span>
					</>
				) : turnCount > 0 ? (
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
								className="min-h-11 min-w-11 rounded-lg"
								disabled={!canArchive}
								onClick={onArchive}
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
						{isArchived ? "续聊会自动保存" : "保存临时会话，之后可继续对话"}
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
									"min-h-11 min-w-11 rounded-lg",
									drawerOpen
										? "border-evidence/40 bg-evidence/10 text-evidence hover:bg-evidence/15"
										: "border-evidence/35 text-evidence hover:border-evidence/55 hover:bg-evidence/8",
								)}
								onClick={() => onDrawerOpenChange(!drawerOpen)}
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
						{drawerOpen ? "收起引用来源面板" : "引用片段与来源位置"}
					</TooltipContent>
				</Tooltip>
			</div>
		</div>
	);
}
