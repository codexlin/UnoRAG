"use client";

import { Files } from "lucide-react";
import type { LocalTurn } from "@/components/app/ask/ask-turn-state";
import { CitationSourceCard } from "@/components/app/citation-source-card";
import {
	Trace,
	TraceCollapsible,
	TraceCollapsibleContent,
	TraceCollapsibleTrigger,
	TraceIcon,
	TraceLine,
	TraceTitle,
} from "@/components/ui/trace";
import { formatDateTime } from "@/lib/format";
import type { UiCitation } from "@/lib/ui-types";

export function AskAnswerSources({
	turn,
	activeCitation,
	activeCitationTurnId,
	onOpenCitation,
}: {
	turn: Pick<LocalTurn, "id" | "citations" | "completedAt">;
	activeCitation: UiCitation | null;
	activeCitationTurnId: string | null;
	onOpenCitation: (citation: UiCitation, turnId: string) => void;
}) {
	if (turn.citations.length === 0) return null;
	return (
		<section className="border-t border-border/60 pt-1" aria-label="回答依据">
			<Trace>
				<TraceCollapsible>
					<TraceCollapsibleTrigger className="min-h-11">
						<TraceLine>
							<TraceIcon>
								<Files className="size-4" aria-hidden />
							</TraceIcon>
							<TraceTitle className="whitespace-normal [overflow-wrap:anywhere]">
								回答依据 · {turn.citations.length} 条
							</TraceTitle>
						</TraceLine>
					</TraceCollapsibleTrigger>
					<TraceCollapsibleContent>
						<ul className="grid min-w-0 gap-2 pb-3 @min-[32rem]:grid-cols-2">
							{turn.citations.map((citation) => (
								<li key={citation.id}>
									<CitationSourceCard
										citation={citation}
										active={
											activeCitationTurnId === turn.id &&
											activeCitation?.id === citation.id
										}
										onSelect={(source) => onOpenCitation(source, turn.id)}
										compact
									/>
								</li>
							))}
						</ul>
						{turn.completedAt ? (
							<p className="pb-2 text-xs text-muted-foreground">
								完成于 {formatDateTime(turn.completedAt)}
							</p>
						) : null}
					</TraceCollapsibleContent>
				</TraceCollapsible>
			</Trace>
		</section>
	);
}
