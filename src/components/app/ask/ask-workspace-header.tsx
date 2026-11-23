"use client";

import {
	Archive,
	ChevronRight,
	PanelRightClose,
	PanelRightOpen,
} from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { useCan } from "@/components/app/can";
import { LibraryCombobox } from "@/components/app/library-combobox";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ApiLibrary } from "@/lib/api";
import { useInterfaceText } from "@/lib/i18n/provider";
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
	onTraceRequestedChange: (enabled: boolean) => void;
	traceRequested: boolean;
	threadTitle: string | null;
	turnCount: number;
};

export function AskTraceToggle({
	checked,
	onCheckedChange,
}: {
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
}) {
	const canInspect = useCan("writeLibraries");
	const t = useInterfaceText();
	const id = useId();
	if (!canInspect) return null;
	return (
		<Label htmlFor={id} className="min-h-11 cursor-pointer gap-2 px-2 text-xs">
			{t("检索透视", "Retrieval trace")}
			<Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
		</Label>
	);
}

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
	onTraceRequestedChange,
	traceRequested,
	threadTitle,
	turnCount,
}: AskWorkspaceHeaderProps) {
	const t = useInterfaceText();
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
						{t("创建知识库", "Create library")}
						<ChevronRight className="size-3.5" />
					</Link>
				) : !library ? (
					<span>{t("请选择知识库", "Choose a library")}</span>
				) : library.doc_count === 0 || library.status === "empty" ? (
					<Link
						href="/app/libraries"
						className="inline-flex items-center gap-1 font-medium text-evidence underline-offset-4 hover:underline"
					>
						{t(
							"知识库为空，上传文档",
							"This library is empty. Upload documents",
						)}
						<ChevronRight className="size-3.5" />
					</Link>
				) : (
					<span
						className="inline-flex items-center gap-1.5"
						title={t(
							"已完成索引、可检索的文档数 / 知识库内文档总数",
							"Indexed and searchable documents / all documents in the library",
						)}
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
						<span>{t("可检索文档", "Searchable documents")}</span>
					</span>
				)}
				<span className="text-border" aria-hidden>
					|
				</span>
				<span className="inline-flex items-center gap-1 tabular-nums">
					<span className="text-foreground/80">{turnCount}</span>
					<span>{t("问", "Turns")}</span>
				</span>
				{isArchived ? (
					<>
						<span className="text-border" aria-hidden>
							|
						</span>
						<span className="truncate text-evidence" title={threadTitle || ""}>
							{t("已归档", "Archived")}
							{threadTitle ? ` · ${threadTitle}` : ""}
						</span>
					</>
				) : turnCount > 0 ? (
					<>
						<span className="text-border" aria-hidden>
							|
						</span>
						<span
							title={t(
								"关闭或刷新后可能丢失",
								"May be lost when you close or refresh",
							)}
						>
							{t("未归档", "Not archived")}
						</span>
					</>
				) : null}
			</div>

			<div className="ml-auto flex shrink-0 items-center gap-2">
				<AskTraceToggle
					checked={traceRequested}
					onCheckedChange={onTraceRequestedChange}
				/>
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
								aria-label={t("归档当前会话", "Archive this conversation")}
							>
								<Archive data-icon="inline-start" />
								<span className="hidden sm:inline">
									{archiving
										? t("归档中…", "Archiving…")
										: isArchived
											? t("已归档", "Archived")
											: t("归档", "Archive")}
								</span>
							</Button>
						}
					/>
					<TooltipContent side="bottom">
						{isArchived
							? t("续聊会自动保存", "Follow-up messages save automatically")
							: t(
									"保存临时会话，之后可继续对话",
									"Save this conversation so you can continue later",
								)}
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
									drawerOpen
										? t("收起引用来源面板", "Hide the sources panel")
										: t("展开引用来源面板", "Show the sources panel")
								}
							>
								{drawerOpen ? (
									<PanelRightClose data-icon="inline-start" />
								) : (
									<PanelRightOpen data-icon="inline-start" />
								)}
								<span className="hidden sm:inline">
									{drawerOpen
										? t("收起引用", "Hide sources")
										: t("引用来源", "Sources")}
								</span>
								<span className="sm:hidden">
									{drawerOpen ? t("收起", "Hide") : t("引用", "Sources")}
								</span>
							</Button>
						}
					/>
					<TooltipContent side="bottom">
						{drawerOpen
							? t("收起引用来源面板", "Hide the sources panel")
							: t(
									"引用片段与来源位置",
									"Evidence excerpts and source locations",
								)}
					</TooltipContent>
				</Tooltip>
			</div>
		</div>
	);
}
