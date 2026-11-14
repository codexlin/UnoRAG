"use client";

import {
	Activity,
	Check,
	Copy,
	LoaderCircle,
	RotateCcw,
	Square,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { hasAskTrace } from "@/components/app/ask/ask-trace-drawer";
import type { LocalTurn } from "@/components/app/ask/ask-turn-state";
import { Button } from "@/components/ui/button";
import { MessageFooter } from "@/components/ui/message";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ApiRetrievalDebug } from "@/lib/api";
import { formatDurationMs } from "@/lib/format";
import { cn } from "@/lib/utils";

const actionClassName =
	"size-11 shrink-0 text-muted-foreground transition-[color,background-color,transform] duration-150 hover:text-foreground motion-safe:active:scale-95";

function CopyAnswerButton({ text }: { text: string }) {
	const [copiedText, setCopiedText] = useState<string | null>(null);
	const [copyingText, setCopyingText] = useState<string | null>(null);
	const attemptRef = useRef(0);
	const inFlightRef = useRef(false);
	const timerRef = useRef<number | null>(null);
	const copied = copiedText === text;
	const copying = copyingText === text;

	// biome-ignore lint/correctness/useExhaustiveDependencies: A new answer invalidates pending clipboard feedback.
	useEffect(
		() => () => {
			attemptRef.current += 1;
			inFlightRef.current = false;
			if (timerRef.current !== null) window.clearTimeout(timerRef.current);
		},
		[text],
	);

	async function copyAnswer() {
		if (inFlightRef.current) return;
		inFlightRef.current = true;
		const attempt = ++attemptRef.current;
		if (timerRef.current !== null) window.clearTimeout(timerRef.current);
		setCopiedText(null);
		setCopyingText(text);
		try {
			await navigator.clipboard.writeText(text);
			if (attempt !== attemptRef.current) return;
			setCopiedText(text);
			timerRef.current = window.setTimeout(() => setCopiedText(null), 1500);
		} catch {
			if (attempt !== attemptRef.current) return;
			toast.error("复制失败", {
				description:
					typeof navigator.clipboard?.writeText === "function"
						? "请重试或手动选择回答正文复制。"
						: "当前连接不支持自动复制，请使用 HTTPS 或手动复制。",
			});
		} finally {
			if (attempt === attemptRef.current) {
				inFlightRef.current = false;
				setCopyingText(null);
			}
		}
	}

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className={cn(
							actionClassName,
							copied && "text-primary hover:text-primary",
						)}
						aria-label={copied ? "已复制回答" : "复制回答"}
						aria-busy={copying}
						disabled={copying}
						focusableWhenDisabled
						onClick={() => void copyAnswer()}
					/>
				}
			>
				{copying ? (
					<LoaderCircle
						className="size-4 motion-safe:animate-spin"
						aria-hidden
					/>
				) : copied ? (
					<Check className="size-4" aria-hidden />
				) : (
					<Copy className="size-4" aria-hidden />
				)}
			</TooltipTrigger>
			<TooltipContent>
				{copied ? "已复制" : copying ? "正在复制…" : "复制回答"}
			</TooltipContent>
			<span className="sr-only" role="status">
				{copied ? "回答已复制" : ""}
			</span>
		</Tooltip>
	);
}

type AskAnswerActionsProps = {
	turn: LocalTurn;
	canAsk: boolean;
	isStreaming: boolean;
	onCancel: () => void;
	onRetry: (turn: LocalTurn) => void;
	onOpenTrace: (
		debug: ApiRetrievalDebug,
		clientDurationMs?: number | null,
	) => void;
};

export function AskAnswerActions({
	turn,
	canAsk,
	isStreaming,
	onCancel,
	onRetry,
	onOpenTrace,
}: AskAnswerActionsProps) {
	const canRetry =
		!turn.pending && Boolean(turn.error || turn.cancelled || turn.refused);
	return (
		<MessageFooter
			role="group"
			aria-label="回答操作"
			className="-ml-3 mt-2 flex-wrap gap-x-1 gap-y-2 px-0 font-normal"
		>
			{!turn.pending && turn.answer.trim() ? (
				<CopyAnswerButton text={turn.answer} />
			) : null}
			{turn.pending ? (
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className={actionClassName}
								aria-label="停止生成"
								onClick={onCancel}
							/>
						}
					>
						<Square className="size-3.5 fill-current" aria-hidden />
					</TooltipTrigger>
					<TooltipContent>停止生成</TooltipContent>
				</Tooltip>
			) : canRetry ? (
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className={actionClassName}
								aria-label="重试"
								disabled={!canAsk || isStreaming}
								onClick={() => onRetry(turn)}
							/>
						}
					>
						<RotateCcw className="size-4" aria-hidden />
					</TooltipTrigger>
					<TooltipContent>重试此问题</TooltipContent>
				</Tooltip>
			) : null}
			{hasAskTrace(turn.retrievalDebug) ? (
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className={actionClassName}
								aria-label="查看请求链路：路由、检索、裁决与生成各阶段耗时"
								onClick={() => {
									if (turn.retrievalDebug)
										onOpenTrace(turn.retrievalDebug, turn.durationMs);
								}}
							/>
						}
					>
						<Activity className="size-4" aria-hidden />
					</TooltipTrigger>
					<TooltipContent>查看请求链路</TooltipContent>
				</Tooltip>
			) : null}
			{turn.durationMs != null ? (
				<span className="ml-auto pl-3 font-mono text-xs tabular-nums text-muted-foreground">
					<span className="sr-only">端到端耗时 </span>
					{formatDurationMs(turn.durationMs)}
				</span>
			) : null}
		</MessageFooter>
	);
}
