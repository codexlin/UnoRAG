"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type TaglineRevealProps = {
	segments: readonly string[];
	isCjk?: boolean;
	className?: string;
};

export function TaglineReveal({
	segments,
	isCjk = false,
	className,
}: TaglineRevealProps) {
	const containerRef = useRef<HTMLParagraphElement | null>(null);
	const reducedMotion = useReducedMotion();
	const [mounted, setMounted] = useState(false);
	const [revealedCount, setRevealedCount] = useState(0);

	useEffect(() => {
		setMounted(true);
	}, []);

	const keyedSegments = useMemo(() => {
		const counts = new Map<string, number>();
		return segments.map((text) => {
			const seen = (counts.get(text) ?? 0) + 1;
			counts.set(text, seen);
			return { key: `${text}#${seen}`, text };
		});
	}, [segments]);

	useEffect(() => {
		if (!mounted) return;
		if (reducedMotion) {
			setRevealedCount(segments.length);
			return;
		}
		let rafId = 0;
		const update = () => {
			rafId = 0;
			const node = containerRef.current;
			if (!node) return;
			const rect = node.getBoundingClientRect();
			const viewportH = window.innerHeight || 1;
			// Reveal cleanly between 86% and 32% of viewport height.
			const start = viewportH * 0.86;
			const end = viewportH * 0.32;
			const progress = Math.min(
				1,
				Math.max(0, (start - rect.top) / (start - end)),
			);
			const nextCount = Math.round(progress * segments.length);
			setRevealedCount((prev) => (prev === nextCount ? prev : nextCount));
		};
		const schedule = () => {
			if (!rafId) rafId = window.requestAnimationFrame(update);
		};
		update();
		window.addEventListener("scroll", schedule, { passive: true });
		window.addEventListener("resize", schedule, { passive: true });
		return () => {
			if (rafId) window.cancelAnimationFrame(rafId);
			window.removeEventListener("scroll", schedule);
			window.removeEventListener("resize", schedule);
		};
	}, [mounted, reducedMotion, segments.length]);

	const isReduced = mounted && Boolean(reducedMotion);

	return (
		<p
			ref={containerRef}
			className={cn(
				"mx-auto max-w-[680px] text-center text-3xl font-semibold leading-[1.35] tracking-[-0.025em] text-balance sm:text-4xl sm:leading-[1.28]",
				className,
			)}
		>
			{keyedSegments.map((item, position) => {
				const active = isReduced || position < revealedCount;
				return (
					<span
						key={item.key}
						className={cn(
							"transition-colors duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
							active ? "text-foreground" : "text-muted-foreground",
						)}
					>
						{item.text}
						{!isCjk && position < keyedSegments.length - 1 ? " " : ""}
					</span>
				);
			})}
		</p>
	);
}
