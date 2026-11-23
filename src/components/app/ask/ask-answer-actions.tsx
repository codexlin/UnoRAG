"use client";

import {
	Activity,
	Check,
	Copy,
	LoaderCircle,
	RotateCcw,
	Square,
	ThumbsDown,
	ThumbsUp,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { hasAskTrace } from "@/components/app/ask/ask-trace-drawer";
import type { LocalTurn } from "@/components/app/ask/ask-turn-state";
import { Button } from "@/components/ui/button";
import { MessageFooter } from "@/components/ui/message";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { submitAskFeedback } from "@/lib/api";
import {
	ASK_FEEDBACK_REASON_CODES,
	ASK_FEEDBACK_REASON_LABELS,
	type AskFeedbackRating,
	type AskFeedbackReasonCode,
} from "@/lib/ask-feedback";
import { formatDurationMs } from "@/lib/format";
import { useInterfaceText } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

const actionClassName =
	"size-11 shrink-0 text-muted-foreground transition-[color,background-color,transform] duration-150 hover:text-foreground motion-safe:active:scale-95";

function CopyAnswerButton({ text }: { text: string }) {
	const t = useInterfaceText();
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
			toast.error(t("复制失败", "Couldn't copy"), {
				description:
					typeof navigator.clipboard?.writeText === "function"
						? t(
								"请重试或手动选择回答正文复制。",
								"Try again or select and copy the answer manually.",
							)
						: t(
								"当前连接不支持自动复制，请使用 HTTPS 或手动复制。",
								"Automatic copying needs HTTPS. Copy the answer manually instead.",
							),
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
						aria-label={
							copied
								? t("已复制回答", "Answer copied")
								: t("复制回答", "Copy answer")
						}
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
				{copied
					? t("已复制", "Copied")
					: copying
						? t("正在复制…", "Copying…")
						: t("复制回答", "Copy answer")}
			</TooltipContent>
			<span className="sr-only" role="status">
				{copied ? t("回答已复制", "Answer copied") : ""}
			</span>
		</Tooltip>
	);
}

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function FeedbackButtons({ requestId }: { requestId: string }) {
	const t = useInterfaceText();
	const [rating, setRating] = useState<AskFeedbackRating | null>(null);
	const [reasonCode, setReasonCode] = useState<AskFeedbackReasonCode | null>(
		null,
	);
	const [saving, setSaving] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);

	async function send(
		nextRating: AskFeedbackRating,
		nextReason?: AskFeedbackReasonCode | null,
	) {
		if (saving) return;
		setSaving(true);
		try {
			await submitAskFeedback({
				request_id: requestId,
				rating: nextRating,
				reason_code: nextRating === "up" ? undefined : (nextReason ?? null),
			});
			setRating(nextRating);
			setReasonCode(nextRating === "up" ? null : (nextReason ?? null));
			setMenuOpen(false);
			toast.success(
				nextRating === "up"
					? t("感谢反馈", "Thanks for your feedback")
					: t("已记录问题反馈", "Feedback recorded"),
			);
		} catch (error) {
			toast.error(t("反馈提交失败", "Couldn't submit feedback"), {
				description:
					error instanceof Error
						? error.message
						: t("请稍后重试", "Try again later"),
			});
		} finally {
			setSaving(false);
		}
	}

	return (
		<>
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className={cn(
								actionClassName,
								rating === "up" && "text-primary hover:text-primary",
							)}
							aria-label={t("回答有帮助", "Helpful answer")}
							aria-pressed={rating === "up"}
							disabled={saving}
							focusableWhenDisabled
							onClick={() => void send("up")}
						/>
					}
				>
					<ThumbsUp className="size-4" aria-hidden />
				</TooltipTrigger>
				<TooltipContent>{t("回答有帮助", "Helpful answer")}</TooltipContent>
			</Tooltip>
			<Popover open={menuOpen} onOpenChange={setMenuOpen}>
				<Tooltip>
					<TooltipTrigger
						render={
							<PopoverTrigger
								render={
									<Button
										type="button"
										variant="ghost"
										size="icon"
										className={cn(
											actionClassName,
											rating === "down" &&
												"text-destructive hover:text-destructive",
										)}
										aria-label={t(
											"反馈回答问题",
											"Report an issue with the answer",
										)}
										aria-pressed={rating === "down"}
										disabled={saving}
										focusableWhenDisabled
									/>
								}
							>
								<ThumbsDown className="size-4" aria-hidden />
							</PopoverTrigger>
						}
					/>
					<TooltipContent>
						{t("反馈回答问题", "Report an issue with the answer")}
					</TooltipContent>
				</Tooltip>
				<PopoverContent align="start" className="w-60 p-2">
					<p className="px-2 py-1 text-xs font-medium text-muted-foreground">
						{t("选择问题原因", "Choose a reason")}
					</p>
					<div className="mt-1 flex flex-col gap-1">
						{ASK_FEEDBACK_REASON_CODES.map((code) => (
							<Button
								key={code}
								type="button"
								variant={
									rating === "down" && reasonCode === code
										? "secondary"
										: "ghost"
								}
								size="sm"
								className="justify-start font-normal"
								disabled={saving}
								onClick={() => void send("down", code)}
							>
								{ASK_FEEDBACK_REASON_LABELS[code]}
							</Button>
						))}
					</div>
				</PopoverContent>
			</Popover>
		</>
	);
}

type AskAnswerActionsProps = {
	turn: LocalTurn;
	canAsk: boolean;
	isStreaming: boolean;
	onCancel: () => void;
	onRetry: (turn: LocalTurn) => void;
	onOpenTrace: (turn: LocalTurn) => void;
};

export function AskAnswerActions({
	turn,
	canAsk,
	isStreaming,
	onCancel,
	onRetry,
	onOpenTrace,
}: AskAnswerActionsProps) {
	const t = useInterfaceText();
	const canRetry =
		!turn.pending && Boolean(turn.error || turn.cancelled || turn.refused);
	const requestId =
		!turn.pending &&
		typeof turn.retrievalDebug?.trace_id === "string" &&
		UUID_PATTERN.test(turn.retrievalDebug.trace_id)
			? turn.retrievalDebug.trace_id
			: null;
	return (
		<MessageFooter
			role="group"
			aria-label={t("回答操作", "Answer actions")}
			className="-ml-3 mt-2 flex-wrap gap-x-1 gap-y-2 px-0 font-normal"
		>
			{!turn.pending && turn.answer.trim() ? (
				<CopyAnswerButton text={turn.answer} />
			) : null}
			{requestId ? (
				<FeedbackButtons key={requestId} requestId={requestId} />
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
								aria-label={t("停止生成", "Stop generating")}
								onClick={onCancel}
							/>
						}
					>
						<Square className="size-3.5 fill-current" aria-hidden />
					</TooltipTrigger>
					<TooltipContent>{t("停止生成", "Stop generating")}</TooltipContent>
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
								aria-label={t("重试", "Retry")}
								disabled={!canAsk || isStreaming}
								onClick={() => onRetry(turn)}
							/>
						}
					>
						<RotateCcw className="size-4" aria-hidden />
					</TooltipTrigger>
					<TooltipContent>
						{t("重试此问题", "Retry this question")}
					</TooltipContent>
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
								aria-label={t(
									"查看请求链路：路由、检索、裁决与生成各阶段耗时",
									"View the request trace: routing, retrieval, evidence checks, and generation timings",
								)}
								onClick={() => onOpenTrace(turn)}
							/>
						}
					>
						<Activity className="size-4" aria-hidden />
					</TooltipTrigger>
					<TooltipContent>
						{t("查看请求链路", "View request trace")}
					</TooltipContent>
				</Tooltip>
			) : null}
			{turn.durationMs != null ? (
				<span className="ml-auto pl-3 font-mono text-xs tabular-nums text-muted-foreground">
					<span className="sr-only">
						{t("端到端耗时", "End-to-end duration")}{" "}
					</span>
					{formatDurationMs(turn.durationMs)}
				</span>
			) : null}
		</MessageFooter>
	);
}
