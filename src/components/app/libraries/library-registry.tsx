"use client";

import { PanelLeftClose, PanelLeftOpen, Plus, Search } from "lucide-react";
import { useState } from "react";
import { Can } from "@/components/app/can";
import { LibraryCombobox } from "@/components/app/library-combobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ApiLibrary } from "@/lib/api";
import { useInterfaceText } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

type LibraryRegistryProps = {
	libraries: ApiLibrary[];
	selectedId: string;
	loading: boolean;
	error: string | null;
	saving: boolean;
	onSelect: (libraryId: string) => void;
	onCreate: () => void;
};

function LibraryStatusDot({ status }: { status: string }) {
	return (
		<span
			className={cn(
				"size-2 shrink-0 rounded-full",
				status === "ready" && "bg-cite",
				status === "indexing" && "bg-survey",
				status === "degraded" && "bg-survey",
				status === "failed" && "bg-destructive",
				status === "empty" && "bg-muted-foreground/40",
				!["ready", "indexing", "degraded", "failed", "empty"].includes(
					status,
				) && "bg-muted-foreground/40",
			)}
			aria-hidden
		/>
	);
}

export function LibraryRegistrySidebar({
	libraries,
	selectedId,
	loading,
	error,
	saving,
	onSelect,
	onCreate,
}: LibraryRegistryProps) {
	const t = useInterfaceText();
	const [query, setQuery] = useState("");
	const [collapsed, setCollapsed] = useState(false);
	const normalized = query.trim().toLocaleLowerCase();
	const visibleLibraries = libraries.filter((library) =>
		`${library.name} ${library.description ?? ""}`
			.toLocaleLowerCase()
			.includes(normalized),
	);
	const documentCount = libraries.reduce(
		(sum, item) => sum + (item.doc_count || 0),
		0,
	);
	const countKnown = libraries.length > 0 || (!loading && !error);

	if (collapsed) {
		return (
			<aside
				aria-label={t("知识库导航", "Library navigation")}
				className="hidden w-12 shrink-0 flex-col items-center border-r bg-background pt-3 md:flex"
			>
				<Button
					variant="ghost"
					size="icon"
					className="size-11 md:size-9"
					aria-label={t("展开知识库导航", "Expand library navigation")}
					title={t("展开知识库导航", "Expand library navigation")}
					onClick={() => setCollapsed(false)}
				>
					<PanelLeftOpen aria-hidden />
				</Button>
			</aside>
		);
	}

	return (
		<aside
			aria-label={t("知识库导航", "Library navigation")}
			className="hidden w-52 min-h-0 min-w-0 max-w-[35%] shrink-0 flex-col overflow-hidden border-r bg-background lg:w-56 md:flex"
		>
			<div className="shrink-0 px-3 pt-3 pb-4">
				<div className="flex items-center justify-between gap-2">
					<h2 className="pl-1 text-sm font-medium">
						{t("知识库", "Libraries")}
					</h2>
					<Button
						variant="ghost"
						size="icon"
						className="size-11 text-muted-foreground md:size-9"
						aria-label={t("收起知识库导航", "Collapse library navigation")}
						title={t("收起知识库导航", "Collapse library navigation")}
						onClick={() => setCollapsed(true)}
					>
						<PanelLeftClose aria-hidden />
					</Button>
				</div>
				<p className="px-1 text-xs text-muted-foreground">
					{countKnown
						? t(
								`${libraries.length} 个知识库 · ${documentCount} 份文档`,
								`${libraries.length} libraries · ${documentCount} documents`,
							)
						: t(
								"知识库与文档数量待确认",
								"Library and document totals unavailable",
							)}
				</p>
				<div className="relative mt-4">
					<Search
						aria-hidden
						className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
					/>
					<Input
						aria-label={t("搜索知识库", "Search libraries")}
						placeholder={t("搜索知识库", "Search libraries")}
						className="h-9 bg-muted/40 pl-8 text-sm"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</div>
			</div>
			<ScrollArea className="min-h-0 flex-1">
				<ul className="flex flex-col gap-0.5 p-2">
					{loading && libraries.length === 0 ? (
						<li className="px-3 py-6 text-sm text-muted-foreground">
							<span role="status">{t("正在加载", "Loading")}</span>
						</li>
					) : null}
					{libraries.length === 0 && !loading && error ? (
						<li className="px-3 py-6 text-sm text-muted-foreground">
							{t("知识库列表未能加载", "Couldn't load libraries")}
						</li>
					) : null}
					{libraries.length === 0 && !loading && !error ? (
						<li className="px-2 py-6 text-center text-sm text-muted-foreground">
							{t("还没有知识库", "No libraries yet")}
						</li>
					) : null}
					{visibleLibraries.length === 0 && libraries.length > 0 ? (
						<li className="px-3 py-6 text-sm text-muted-foreground">
							{t("没有匹配的知识库", "No matching libraries")}
						</li>
					) : null}
					{visibleLibraries.map((library) => (
						<li key={library.id}>
							<button
								type="button"
								aria-current={selectedId === library.id ? "true" : undefined}
								onClick={() => onSelect(library.id)}
								className={cn(
									"flex min-h-16 w-full items-start gap-2.5 rounded-lg border border-transparent px-3 py-3 text-left transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
									selectedId === library.id
										? "bg-sidebar-accent text-sidebar-accent-foreground"
										: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
								)}
							>
								<LibraryStatusDot status={library.status} />
								<span className="min-w-0 flex-1">
									<span
										className={cn(
											"block truncate text-sm font-medium",
											selectedId !== library.id && "text-foreground",
										)}
									>
										{library.name}
									</span>
									{library.description?.trim() ? (
										<span
											className={cn(
												"text-meta mt-0.5 block truncate",
												selectedId !== library.id && "text-muted-foreground",
											)}
										>
											{library.description.trim()}
										</span>
									) : null}
									<span
										className={cn(
											"mt-1 block text-xs",
											selectedId !== library.id && "text-muted-foreground",
										)}
									>
										{library.status === "deleting"
											? t("删除中", "Deleting")
											: library.status === "indexing"
												? t(
														`${library.ready_count}/${library.doc_count} 可用 · 处理中`,
														`${library.ready_count}/${library.doc_count} ready · processing`,
													)
												: library.status === "empty"
													? t("等待资料", "Waiting for documents")
													: t(
															`${library.ready_count}/${library.doc_count} 可检索`,
															`${library.ready_count}/${library.doc_count} searchable`,
														)}
									</span>
								</span>
							</button>
						</li>
					))}
				</ul>
			</ScrollArea>
			<Can cap="manageLibraries">
				<div className="shrink-0 border-t border-border/70 p-3">
					<Button
						type="button"
						className="h-auto min-h-11 w-full whitespace-normal md:min-h-9"
						disabled={saving}
						onClick={onCreate}
					>
						<Plus data-icon="inline-start" />
						{t("新建知识库", "Create library")}
					</Button>
				</div>
			</Can>
		</aside>
	);
}

export function MobileLibraryPicker({
	libraries,
	selectedId,
	saving,
	onSelect,
	onCreate,
}: Omit<LibraryRegistryProps, "loading" | "error">) {
	const t = useInterfaceText();
	return (
		<div className="border-b border-border/70 bg-card px-4 py-3 md:hidden">
			<div className="flex items-end gap-2">
				<LibraryCombobox
					libraries={libraries}
					value={selectedId}
					onValueChange={onSelect}
					className="min-w-0 flex-1"
					label={t("当前知识库", "Current library")}
				/>
				<Can cap="manageLibraries">
					<Button
						type="button"
						size={libraries.length === 0 ? "default" : "icon"}
						className="min-h-11 min-w-11 shrink-0 rounded-md"
						disabled={saving}
						onClick={onCreate}
						aria-label={t("新建知识库", "Create library")}
					>
						<Plus aria-hidden="true" />
						{libraries.length === 0 ? t("新建", "New") : null}
					</Button>
				</Can>
			</div>
		</div>
	);
}
