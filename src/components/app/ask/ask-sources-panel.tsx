"use client";

import { PanelRightClose } from "lucide-react";
import { CitationSourceCard } from "@/components/app/citation-source-card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useInterfaceText } from "@/lib/i18n/provider";
import type { UiCitation } from "@/lib/ui-types";

export function AskSourcesPanel({
	activeCitation,
	onClose,
}: {
	activeCitation: UiCitation | null;
	onClose: () => void;
}) {
	const t = useInterfaceText();
	return (
		<div className="flex h-full min-h-0 w-full flex-col">
			<div className="flex min-h-16 shrink-0 items-center justify-between border-b px-5">
				<h2 className="text-base font-medium">{t("引用来源", "Sources")}</h2>
				<button
					type="button"
					onClick={onClose}
					className="inline-flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
					aria-label={t("收起引用来源面板", "Hide sources panel")}
					title={t("收起引用来源面板", "Hide sources panel")}
				>
					<PanelRightClose className="size-4" aria-hidden />
				</button>
			</div>
			<ScrollArea className="min-h-0 flex-1">
				<div className="p-5">
					{activeCitation ? (
						<div>
							<CitationSourceCard
								key={activeCitation.id}
								citation={activeCitation}
								active
								expanded
								showDiagnostics
							/>
						</div>
					) : (
						<p className="py-8 text-center text-sm text-muted-foreground">
							{t("尚未选择引用", "No source selected")}
						</p>
					)}
				</div>
			</ScrollArea>
		</div>
	);
}
