"use client";

import {
	AlertCircle,
	Check,
	Copy,
	RotateCcw,
	Terminal as TerminalIcon,
} from "lucide-react";
import { motion, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useInterfaceText } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

const QUICKSTART_COMMAND =
	"git clone https://github.com/codexlin/UnoRAG.git\ncd UnoRAG\n./start.sh";

const COMMAND_LINES = [
	"git clone https://github.com/codexlin/UnoRAG.git",
	"cd UnoRAG && ./start.sh",
] as const;

type TypingLineProps = {
	text: string;
	active: boolean;
	instant: boolean;
	charDelayMs?: number;
	onDone?: () => void;
};

function TypingLine({
	text,
	active,
	instant,
	charDelayMs = 20,
	onDone,
}: TypingLineProps) {
	const [shown, setShown] = useState(instant ? text.length : 0);
	const doneRef = useRef(false);
	const onDoneRef = useRef(onDone);
	onDoneRef.current = onDone;

	useEffect(() => {
		if (instant) {
			setShown(text.length);
			if (!doneRef.current) {
				doneRef.current = true;
				onDoneRef.current?.();
			}
			return;
		}
		if (!active) return;

		setShown(0);
		doneRef.current = false;
		let index = 0;
		const timer = window.setInterval(() => {
			index += 1;
			setShown(index);
			if (index >= text.length) {
				window.clearInterval(timer);
				if (!doneRef.current) {
					doneRef.current = true;
					onDoneRef.current?.();
				}
			}
		}, charDelayMs);
		return () => window.clearInterval(timer);
	}, [active, instant, text, charDelayMs]);

	if (!instant && !active && shown === 0) return null;

	const typing = !instant && active && shown < text.length;

	return (
		<div className="flex items-start gap-2 text-foreground">
			<span aria-hidden className="select-none text-muted-foreground">
				$
			</span>
			<span>
				{text.slice(0, shown)}
				{typing ? (
					<span
						aria-hidden
						className="ml-0.5 inline-block h-[1em] w-[0.45em] translate-y-[0.12em] bg-foreground/80"
					/>
				) : null}
			</span>
		</div>
	);
}

type StatusLineProps = {
	visible: boolean;
	instant: boolean;
	tone?: "cite" | "muted";
	children: string;
};

function StatusLine({
	visible,
	instant,
	tone = "cite",
	children,
}: StatusLineProps) {
	if (!instant && !visible) return null;

	const toneClass =
		tone === "cite" ? "text-cite" : "text-muted-foreground pt-1";

	if (instant) {
		return <div className={cn("leading-7", toneClass)}>{children}</div>;
	}

	return (
		<motion.div
			initial={{ opacity: 0, y: 4 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
			className={cn("leading-7", toneClass)}
		>
			{children}
		</motion.div>
	);
}

export function QuickstartSnippet() {
	const t = useInterfaceText();
	const prefersReducedMotion = useReducedMotion();
	const [mounted, setMounted] = useState(false);
	const [status, setStatus] = useState<"idle" | "copied" | "manual">("idle");
	const [runKey, setRunKey] = useState(0);
	const [step, setStep] = useState(0);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const hiddenCopyRef = useRef<HTMLElement | null>(null);
	const timerRef = useRef<number | null>(null);

	const inView = useInView(containerRef, { once: true, amount: 0.35 });
	const instant = !mounted || Boolean(prefersReducedMotion);

	useEffect(() => {
		setMounted(true);
	}, []);

	useEffect(() => {
		return () => {
			if (timerRef.current) window.clearTimeout(timerRef.current);
		};
	}, []);

	// Start sequence when scrolled into view
	useEffect(() => {
		if (instant || !inView) return;
		setStep((prev) => Math.max(prev, 1));
	}, [instant, inView]);

	// Advance sequential output lines after the 2nd typed command finishes
	useEffect(() => {
		if (instant || step < 3 || step >= 6) return;
		const id = window.setTimeout(() => setStep((prev) => prev + 1), 360);
		return () => window.clearTimeout(id);
	}, [instant, step]);

	async function copyCommand() {
		if (timerRef.current) window.clearTimeout(timerRef.current);
		try {
			await navigator.clipboard.writeText(QUICKSTART_COMMAND);
			setStatus("copied");
			timerRef.current = window.setTimeout(() => setStatus("idle"), 2000);
		} catch {
			if (hiddenCopyRef.current && typeof window !== "undefined") {
				const selection = window.getSelection();
				const range = document.createRange();
				range.selectNodeContents(hiddenCopyRef.current);
				selection?.removeAllRanges();
				selection?.addRange(range);
			}
			setStatus("manual");
			timerRef.current = window.setTimeout(() => setStatus("idle"), 3500);
		}
	}

	function replaySequence() {
		if (instant) return;
		setRunKey((prev) => prev + 1);
		setStep(1);
	}

	const outputLines = [
		{
			tone: "cite" as const,
			text: t(
				"✓ PostgreSQL、Qdrant 与 Redis 容器已就绪",
				"✓ PostgreSQL, Qdrant, and Redis containers ready",
			),
		},
		{
			tone: "cite" as const,
			text: t(
				"✓ 数据库结构迁移与控制面初始化完成",
				"✓ Control-plane migrations applied",
			),
		},
		{
			tone: "cite" as const,
			text: t(
				"✓ Web 工作台与 DBOS 后台任务进程在线",
				"✓ Web workspace and DBOS worker online",
			),
		},
		{
			tone: "muted" as const,
			text: t(
				"→ 本地工作台已就绪：http://localhost:3000",
				"→ Local workspace ready at http://localhost:3000",
			),
		},
	];

	return (
		<div
			ref={containerRef}
			className="overflow-hidden rounded-xl border border-border bg-card shadow-2xs"
		>
			<div className="flex items-center justify-between gap-3 border-b border-border bg-muted/40 px-4 py-1.5 sm:px-5 sm:py-2">
				<div className="flex min-w-0 items-center gap-3">
					<span aria-hidden className="flex items-center gap-1.5">
						<span className="size-2.5 rounded-full bg-border" />
						<span className="size-2.5 rounded-full bg-border" />
						<span className="size-2.5 rounded-full bg-border" />
					</span>
					<span className="inline-flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
						<TerminalIcon className="size-3.5 shrink-0" aria-hidden />
						<span className="truncate">
							{t("Docker Compose 快速启动", "Docker Compose quickstart")}
						</span>
					</span>
				</div>
				<div className="flex shrink-0 items-center gap-0.5">
					{!instant && step >= 6 ? (
						<Button
							type="button"
							variant="ghost"
							size="icon"
							onClick={replaySequence}
							aria-label={t("重播终端演示", "Replay terminal preview")}
							title={t("重播终端演示", "Replay terminal preview")}
							className="size-11 text-muted-foreground hover:text-foreground md:size-8"
						>
							<RotateCcw className="size-3.5" aria-hidden />
						</Button>
					) : null}
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={copyCommand}
						className="min-h-11 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground md:min-h-8"
						aria-live="polite"
					>
						{status === "copied" ? (
							<>
								<Check className="size-3.5 text-cite" aria-hidden />
								{t("已复制", "Copied")}
							</>
						) : status === "manual" ? (
							<>
								<AlertCircle
									className="size-3.5 text-destructive"
									aria-hidden
								/>
								{t("已选中，请手动复制", "Selected — copy manually")}
							</>
						) : (
							<>
								<Copy className="size-3.5" aria-hidden />
								{t("复制命令", "Copy")}
							</>
						)}
					</Button>
				</div>
			</div>
			<div className="relative">
				<pre
					// biome-ignore lint/a11y/noNoninteractiveTabindex: overflowing terminal block supports keyboard horizontal scrolling
					tabIndex={0}
					className="min-h-[216px] overflow-x-auto px-4 py-4 font-mono text-xs leading-7 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring sm:min-h-[232px] sm:px-5 sm:py-5 sm:text-[13px]"
				>
					<code key={runKey} className="block space-y-0.5">
						<TypingLine
							text={COMMAND_LINES[0]}
							active={step >= 1}
							instant={instant}
							charDelayMs={18}
							onDone={() => {
								if (!instant) setStep((prev) => Math.max(prev, 2));
							}}
						/>
						<TypingLine
							text={COMMAND_LINES[1]}
							active={step >= 2}
							instant={instant}
							charDelayMs={22}
							onDone={() => {
								if (!instant) setStep((prev) => Math.max(prev, 3));
							}}
						/>
						<div className="pt-1.5">
							{outputLines.map((line, index) => (
								<StatusLine
									key={line.text}
									visible={step >= index + 3}
									instant={instant}
									tone={line.tone}
								>
									{line.text}
								</StatusLine>
							))}
						</div>
					</code>
				</pre>
				<code ref={hiddenCopyRef} className="sr-only">
					{QUICKSTART_COMMAND}
				</code>
			</div>
		</div>
	);
}
