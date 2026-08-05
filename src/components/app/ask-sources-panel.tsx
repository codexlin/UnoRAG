"use client";

import { PanelRightClose } from "lucide-react";

import { CitationSourceCard } from "@/components/app/citation-source-card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { UiCitation } from "@/lib/ui-types";

export function AskSourcesPanel({
	activeCitation,
	onClose,
}: {
	activeCitation: UiCitation | null;
	onClose: () => void;
}) {
	return (
		<div className="flex h-full min-h-0 w-full flex-col">
			<div className="flex h-12 shrink-0 items-center justify-between border-b border-border/70 px-4">
				<div>
					<p className="text-meta font-mono tracking-[0.16em] text-cite uppercase">
						Evidence
					</p>
					<p className="text-[0.9375rem] font-medium leading-snug text-foreground">
						证据轨道
					</p>
				</div>
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								type="button"
								onClick={onClose}
								className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
								aria-label="收起引用来源面板"
							>
								<PanelRightClose className="size-4" aria-hidden />
							</button>
						}
					/>
					<TooltipContent side="left">关闭引用来源面板</TooltipContent>
				</Tooltip>
			</div>
			<ScrollArea className="min-h-0 flex-1">
				<div className="p-4">
					{activeCitation ? (
						<div className="desk-enter">
							<CitationSourceCard
								citation={activeCitation}
								active
								expanded
								showDiagnostics
							/>
						</div>
					) : (
						<div className="text-ui desk-enter space-y-2 text-muted-foreground">
							<p>
								点击回答中的引用编号或下方依据，即可在这里核对完整原文与文档位置。
							</p>
							<p className="text-meta font-mono text-muted-foreground/80">
								检索分数收纳在证据卡的诊断区。
							</p>
						</div>
					)}
				</div>
			</ScrollArea>
		</div>
	);
}
