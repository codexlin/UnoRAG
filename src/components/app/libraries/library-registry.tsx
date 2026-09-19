"use client";

import { Plus } from "lucide-react";

import { Can } from "@/components/app/can";
import { LibraryCombobox } from "@/components/app/library-combobox";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ApiLibrary } from "@/lib/api";
import { cn } from "@/lib/utils";

type LibraryRegistryProps = {
	libraries: ApiLibrary[];
	selectedId: string;
	loading: boolean;
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
	saving,
	onSelect,
	onCreate,
}: LibraryRegistryProps) {
	const documentCount = libraries.reduce(
		(sum, item) => sum + (item.doc_count || 0),
		0,
	);

	return (
		<aside className="hidden w-72 shrink-0 flex-col border-r border-border/80 bg-card md:flex">
			<div className="space-y-1 border-b border-border/70 px-4 py-4">
				<p className="text-meta font-mono tracking-[0.16em] text-cite uppercase">
					Knowledge registry
				</p>
				<h2 className="font-heading text-base font-semibold">知识库</h2>
				<p className="text-meta font-mono text-muted-foreground">
					{libraries.length} 个知识库 · {documentCount} 份文档
				</p>
			</div>
			<ScrollArea className="min-h-0 flex-1">
				<ul className="flex flex-col gap-0.5 p-2">
					{libraries.length === 0 && !loading ? (
						<li className="px-2 py-6 text-center text-ui text-muted-foreground">
							还没有知识库
						</li>
					) : null}
					{libraries.map((library) => (
						<li key={library.id}>
							<button
								type="button"
								onClick={() => onSelect(library.id)}
								className={cn(
									"flex w-full items-start gap-2.5 rounded-sm border-l-2 px-2.5 py-2.5 text-left transition-colors",
									selectedId === library.id
										? "border-l-cite bg-cite/8 text-foreground"
										: "border-l-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
								)}
							>
								<LibraryStatusDot status={library.status} />
								<span className="min-w-0 flex-1">
									<span className="block truncate text-[0.9375rem] font-medium text-foreground">
										{library.name}
									</span>
									{library.description?.trim() ? (
										<span className="text-meta mt-0.5 block truncate text-muted-foreground">
											{library.description.trim()}
										</span>
									) : null}
									<span className="text-meta mt-0.5 block font-mono text-muted-foreground">
										{library.status === "indexing"
											? `${library.ready_count}/${library.doc_count} 可用 · 处理中`
											: library.status === "empty"
												? "等待资料"
												: `${library.ready_count}/${library.doc_count} 可检索`}
									</span>
								</span>
							</button>
						</li>
					))}
				</ul>
			</ScrollArea>
			<Can cap="manageLibraries">
				<div className="border-t border-border/70 p-3">
					<Button
						type="button"
						variant="outline"
						className="w-full rounded-md border-dashed"
						disabled={saving}
						onClick={onCreate}
					>
						<Plus data-icon="inline-start" />
						新建知识库
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
}: Omit<LibraryRegistryProps, "loading">) {
	return (
		<div className="border-b border-border/70 bg-card px-4 py-3 md:hidden">
			<div className="flex items-end gap-2">
				<LibraryCombobox
					libraries={libraries}
					value={selectedId}
					onValueChange={onSelect}
					className="min-w-0 flex-1"
					label="当前知识库"
				/>
				<Can cap="manageLibraries">
					<Button
						type="button"
						variant={libraries.length === 0 ? "default" : "outline"}
						size={libraries.length === 0 ? "default" : "icon"}
						className="h-10 shrink-0 rounded-md"
						disabled={saving}
						onClick={onCreate}
						aria-label="新建知识库"
					>
						<Plus aria-hidden="true" />
						{libraries.length === 0 ? "新建" : null}
					</Button>
				</Can>
			</div>
		</div>
	);
}
