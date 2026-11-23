"use client";

import {
	motion,
	useMotionTemplate,
	useMotionValue,
	useReducedMotion,
} from "motion/react";
import { type PointerEvent, type ReactNode, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type SpotlightCardProps = {
	children: ReactNode;
	className?: string;
	contentClassName?: string;
	spotlightSize?: number;
};

/**
 * Restrained 1px border-only cursor spotlight card inspired by Magic UI's MagicCard.
 * Uses semantic theme tokens (`--primary` / `--border`) and `motion/react` GPU motion values,
 * staying completely static on touch pointers and under `prefers-reduced-motion: reduce`.
 */
export function SpotlightCard({
	children,
	className,
	contentClassName,
	spotlightSize = 240,
}: SpotlightCardProps) {
	const prefersReducedMotion = useReducedMotion();
	const [mounted, setMounted] = useState(false);
	const [hovered, setHovered] = useState(false);
	const mouseX = useMotionValue(-spotlightSize);
	const mouseY = useMotionValue(-spotlightSize);

	useEffect(() => {
		setMounted(true);
	}, []);

	const reducedMotion = mounted && Boolean(prefersReducedMotion);

	const lightSpotlight = useMotionTemplate`radial-gradient(${spotlightSize}px circle at ${mouseX}px ${mouseY}px, color-mix(in oklch, var(--primary) 54%, transparent), transparent 72%)`;
	const darkSpotlight = useMotionTemplate`radial-gradient(${spotlightSize}px circle at ${mouseX}px ${mouseY}px, color-mix(in oklch, var(--primary) 68%, transparent), transparent 72%)`;

	function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
		if (reducedMotion || event.pointerType !== "mouse") return;
		const { left, top } = event.currentTarget.getBoundingClientRect();
		mouseX.set(event.clientX - left);
		mouseY.set(event.clientY - top);
		if (!hovered) setHovered(true);
	}

	function handlePointerLeave() {
		setHovered(false);
	}

	return (
		<div
			onPointerMove={handlePointerMove}
			onPointerLeave={handlePointerLeave}
			className={cn("relative rounded-xl bg-border p-px shadow-sm", className)}
		>
			{mounted && !reducedMotion ? (
				<>
					<motion.div
						aria-hidden
						className={cn(
							"pointer-events-none absolute inset-0 rounded-[inherit] transition-opacity duration-300 dark:hidden",
							hovered ? "opacity-100" : "opacity-0",
						)}
						style={{ background: lightSpotlight }}
					/>
					<motion.div
						aria-hidden
						className={cn(
							"pointer-events-none absolute inset-0 hidden rounded-[inherit] transition-opacity duration-300 dark:block",
							hovered ? "opacity-100" : "opacity-0",
						)}
						style={{ background: darkSpotlight }}
					/>
				</>
			) : null}
			<div
				className={cn(
					"relative z-10 rounded-[max(0px,calc(var(--radius-xl)-1px))] bg-card p-6 text-card-foreground sm:p-8",
					contentClassName,
				)}
			>
				{children}
			</div>
		</div>
	);
}
