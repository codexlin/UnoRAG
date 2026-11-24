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
	const [scrollProgress, setScrollProgress] = useState(0);

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
			setScrollProgress(1);
			return;
		}
		let rafId = 0;
		const update = () => {
			rafId = 0;
			const node = containerRef.current;
			if (!node) return;
			const rect = node.getBoundingClientRect();
			const viewportH = window.innerHeight || 1;
			// Smooth continuous reveal across 86% -> 30% of viewport height.
			const start = viewportH * 0.86;
			const end = viewportH * 0.3;
			const progress = Math.min(
				1,
				Math.max(0, (start - rect.top) / (start - end)),
			);
			const quantized = Math.round(progress * 100) / 100;
			setScrollProgress((prev) => (prev === quantized ? prev : quantized));
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
	}, [mounted, reducedMotion]);

	const isReduced = mounted && Boolean(reducedMotion);
	const total = Math.max(1, keyedSegments.length);

	return (
		<p
			ref={containerRef}
			className={cn(
				"mx-auto max-w-[680px] text-center text-3xl font-semibold leading-[1.35] tracking-[-0.025em] text-balance sm:text-4xl sm:leading-[1.28]",
				className,
			)}
		>
			{keyedSegments.map((item, position) => {
				const segStart = (position / total) * 0.84;
				const segSpan = Math.max(0.14, 1.8 / total);
				const localP = isReduced
					? 1
					: Math.min(1, Math.max(0, (scrollProgress - segStart) / segSpan));
				const opacity = isReduced ? 1 : 0.32 + 0.68 * localP;
				return (
					<span
						key={item.key}
						style={{ opacity }}
						className="text-foreground transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
					>
						{item.text}
						{!isCjk && position < keyedSegments.length - 1 ? " " : ""}
					</span>
				);
			})}
		</p>
	);
}
