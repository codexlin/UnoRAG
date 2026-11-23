"use client";

import { flushSync } from "react-dom";

type TransitionOrigin =
	| { x: number; y: number }
	| HTMLElement
	| null
	| undefined;

type ViewTransitionLike = {
	ready: Promise<void>;
};

type DocumentWithViewTransition = Document & {
	startViewTransition?: (callback: () => void) => ViewTransitionLike;
};

function resolveOrigin(origin: TransitionOrigin): { x: number; y: number } {
	if (origin && "x" in origin && "y" in origin) {
		return { x: origin.x, y: origin.y };
	}
	if (origin instanceof HTMLElement) {
		const rect = origin.getBoundingClientRect();
		if (rect.width > 0 || rect.height > 0) {
			return {
				x: rect.left + rect.width / 2,
				y: rect.top + rect.height / 2,
			};
		}
	}
	return {
		x: typeof window !== "undefined" ? window.innerWidth - 48 : 0,
		y: 28,
	};
}

/**
 * Applies a theme or appearance DOM mutation inside a native View Transition
 * circular reveal expanding from the clicked trigger (inspired by Magic UI's
 * AnimatedThemeToggler). Falls back immediately when View Transitions are
 * unsupported or `prefers-reduced-motion: reduce` is active.
 */
export function runCircularThemeTransition(
	applyUpdate: () => void,
	origin?: TransitionOrigin,
	duration = 420,
) {
	if (typeof document === "undefined" || typeof window === "undefined") {
		applyUpdate();
		return;
	}

	const doc = document as DocumentWithViewTransition;
	const prefersReducedMotion = window.matchMedia(
		"(prefers-reduced-motion: reduce)",
	).matches;

	if (prefersReducedMotion || typeof doc.startViewTransition !== "function") {
		applyUpdate();
		return;
	}

	const { x, y } = resolveOrigin(origin);
	const maxRadius = Math.hypot(
		Math.max(x, window.innerWidth - x),
		Math.max(y, window.innerHeight - y),
	);

	const transition = doc.startViewTransition(() => {
		flushSync(() => {
			applyUpdate();
		});
	});

	void transition.ready
		.then(() => {
			document.documentElement.animate(
				{
					clipPath: [
						`circle(0px at ${x}px ${y}px)`,
						`circle(${maxRadius}px at ${x}px ${y}px)`,
					],
				},
				{
					duration,
					easing: "cubic-bezier(0.22, 1, 0.36, 1)",
					pseudoElement: "::view-transition-new(root)",
				},
			);
		})
		.catch(() => {
			// Ignore interrupted/cancelled transitions during rapid toggles.
		});
}

/** Synchronously reflects light/dark class & colorScheme so View Transition captures the new snapshot immediately. */
export function syncResolvedColorMode(mode: "light" | "dark") {
	const root = document.documentElement;
	root.classList.remove("light", "dark");
	root.classList.add(mode);
	root.style.colorScheme = mode;
}
