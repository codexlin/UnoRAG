"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@/components/ui/hover-card";
import { useInterfaceText } from "@/lib/i18n/provider";
import type { UiCitation } from "@/lib/ui-types";

export function InlineCitation({
	citation,
	onSelect,
}: {
	citation: UiCitation;
	onSelect: (citation: UiCitation) => void;
}) {
	const t = useInterfaceText();
	const [open, setOpen] = useState(false);
	const excerpt = citation.snippet || citation.text;
	return (
		<HoverCard open={open} onOpenChange={setOpen}>
			<HoverCardTrigger
				delay={300}
				closeDelay={100}
				render={
					<Button
						type="button"
						variant="ghost"
						size="xs"
						aria-label={t(
							`查看引用 ${citation.index}：${citation.title}`,
							`View source ${citation.index}: ${citation.title}`,
						)}
						data-citation-id={citation.id}
						onClick={() => {
							setOpen(false);
							onSelect(citation);
						}}
						className="mx-0.5 h-auto min-h-7 min-w-6 rounded-sm border-evidence/30 bg-evidence/5 px-1 align-middle font-mono text-xs font-medium leading-none text-evidence hover:bg-evidence/12 hover:text-evidence pointer-coarse:min-h-11 pointer-coarse:min-w-11"
					/>
				}
			>
				{citation.index}
			</HoverCardTrigger>
			<HoverCardContent
				align="start"
				className="max-h-[min(32rem,var(--available-height))] w-80 space-y-3 overflow-y-auto overscroll-contain p-4 [overflow-wrap:anywhere]"
			>
				<div className="space-y-1">
					<p className="text-xs text-muted-foreground">
						{t("来源预览", "Source preview")}
					</p>
					<p className="font-medium leading-6">{citation.title}</p>
					{citation.filename ? (
						<p className="text-xs text-muted-foreground">{citation.filename}</p>
					) : null}
				</div>
				{citation.sectionPath ||
				citation.page ||
				citation.source?.row_start != null ? (
					<div className="space-y-1 text-xs text-muted-foreground">
						{citation.sectionPath ? <p>{citation.sectionPath}</p> : null}
						{citation.page ? (
							<p>{t(`页 ${citation.page}`, `Page ${citation.page}`)}</p>
						) : null}
						{citation.source?.row_start != null ? (
							<p>
								{t(
									`表格行组 ${citation.source.row_start + 1}${citation.source.row_end != null ? ` 至 ${citation.source.row_end + 1}` : ""}`,
									`Table rows ${citation.source.row_start + 1}${citation.source.row_end != null ? `–${citation.source.row_end + 1}` : ""}`,
								)}
							</p>
						) : null}
					</div>
				) : null}
				<p className="line-clamp-4 whitespace-pre-wrap text-sm leading-6">
					{excerpt || t("未记录来源片段", "No source excerpt recorded")}
				</p>
				<dl className="space-y-1 border-t pt-3 text-xs">
					<dt className="text-muted-foreground">
						{t("回答所用版本", "Version used")}
					</dt>
					<dd className="font-mono">
						{citation.source?.document_version_id ||
							t("未记录", "Not recorded")}
					</dd>
				</dl>
			</HoverCardContent>
		</HoverCard>
	);
}
