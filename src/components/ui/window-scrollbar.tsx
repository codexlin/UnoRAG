"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const MIN_THUMB_HEIGHT = 32;
const IDLE_HIDE_DELAY_MS = 900;

/**
 * Overlay scrollbar for root document (`<html>`) scrolling on public and auth
 * pages where the native inset scrollbar is hidden to prevent layout shift and
 * Base UI scroll-lock jitter. Renders nothing when the document does not
 * overflow (such as inside `/app/*`, which uses `h-dvh overflow-hidden` and
 * internal Base UI `ScrollArea` viewports).
 */
export function WindowScrollbar() {
	const pathname = usePathname();
	const trackRef = useRef<HTMLDivElement | null>(null);
	const thumbRef = useRef<HTMLDivElement | null>(null);
	const hideTimerRef = useRef<number | null>(null);
	const frameRef = useRef<number | null>(null);
	const dragRef = useRef<{
		pointerId: number;
		startY: number;
		startScrollTop: number;
	} | null>(null);

	const [scrollable, setScrollable] = useState(false);
	const [scrolling, setScrolling] = useState(false);
	const [hovering, setHovering] = useState(false);
	const [dragging, setDragging] = useState(false);

	const syncThumb = useCallback(() => {
		const doc = document.documentElement;
		const viewportHeight = window.innerHeight;
		const scrollHeight = doc.scrollHeight;
		const maxScroll = Math.max(0, scrollHeight - viewportHeight);
		const canScroll = maxScroll > 1;

		setScrollable((prev) => (prev === canScroll ? prev : canScroll));
		if (!canScroll) return;

		const trackEl = trackRef.current;
		const thumbEl = thumbRef.current;
		if (!trackEl || !thumbEl) return;

		const trackRect = trackEl.getBoundingClientRect();
		const styles = window.getComputedStyle(trackEl);
		const padY =
			Number.parseFloat(styles.paddingTop || "0") +
			Number.parseFloat(styles.paddingBottom || "0");
		const trackHeight = Math.max(0, trackRect.height - padY);
		if (trackHeight <= 0) return;

		const thumbHeight = Math.min(
			trackHeight,
			Math.max(MIN_THUMB_HEIGHT, (viewportHeight / scrollHeight) * trackHeight),
		);
		const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
		const scrollTop = Math.min(maxScroll, Math.max(0, window.scrollY));
		const thumbTop = maxScroll > 0 ? (scrollTop / maxScroll) * maxThumbTop : 0;

		thumbEl.style.height = `${thumbHeight}px`;
		thumbEl.style.transform = `translate3d(0, ${thumbTop}px, 0)`;
	}, []);

	const scheduleSync = useCallback(() => {
		if (frameRef.current !== null) return;
		frameRef.current = window.requestAnimationFrame(() => {
			frameRef.current = null;
			syncThumb();
		});
	}, [syncThumb]);

	const pulseScrolling = useCallback(() => {
		setScrolling(true);
		if (hideTimerRef.current !== null) {
			window.clearTimeout(hideTimerRef.current);
		}
		hideTimerRef.current = window.setTimeout(() => {
			hideTimerRef.current = null;
			setScrolling(false);
		}, IDLE_HIDE_DELAY_MS);
	}, []);

	useEffect(() => {
		void pathname;
		syncThumb();
		const handleScroll = () => {
			scheduleSync();
			pulseScrolling();
		};
		window.addEventListener("scroll", handleScroll, { passive: true });
		window.addEventListener("resize", scheduleSync, { passive: true });

		const observer =
			typeof ResizeObserver !== "undefined"
				? new ResizeObserver(() => scheduleSync())
				: null;
		if (observer) {
			observer.observe(document.documentElement);
			if (document.body) observer.observe(document.body);
		}

		return () => {
			window.removeEventListener("scroll", handleScroll);
			window.removeEventListener("resize", scheduleSync);
			observer?.disconnect();
			if (frameRef.current !== null) {
				window.cancelAnimationFrame(frameRef.current);
				frameRef.current = null;
			}
			if (hideTimerRef.current !== null) {
				window.clearTimeout(hideTimerRef.current);
				hideTimerRef.current = null;
			}
		};
	}, [pathname, pulseScrolling, scheduleSync, syncThumb]);

	useEffect(() => {
		if (scrollable) syncThumb();
	}, [scrollable, syncThumb]);

	if (!scrollable) return null;

	const visible = scrolling || hovering || dragging;

	function handleTrackPointerDown(event: React.PointerEvent<HTMLDivElement>) {
		if (event.button !== 0) return;
		const trackEl = trackRef.current;
		const thumbEl = thumbRef.current;
		if (!trackEl || !thumbEl) return;
		if (thumbEl.contains(event.target as Node)) return;

		const trackRect = trackEl.getBoundingClientRect();
		const thumbHeight = thumbEl.offsetHeight;
		const maxThumbTop = Math.max(0, trackRect.height - thumbHeight);
		if (maxThumbTop <= 0) return;

		const clickY = event.clientY - trackRect.top - thumbHeight / 2;
		const ratio = Math.min(1, Math.max(0, clickY / maxThumbTop));
		const maxScroll = Math.max(
			0,
			document.documentElement.scrollHeight - window.innerHeight,
		);
		window.scrollTo({ top: ratio * maxScroll, behavior: "auto" });
		pulseScrolling();
	}

	function handleThumbPointerDown(event: React.PointerEvent<HTMLDivElement>) {
		if (event.button !== 0) return;
		event.stopPropagation();
		event.currentTarget.setPointerCapture(event.pointerId);
		dragRef.current = {
			pointerId: event.pointerId,
			startY: event.clientY,
			startScrollTop: window.scrollY,
		};
		setDragging(true);
		pulseScrolling();
	}

	function handleThumbPointerMove(event: React.PointerEvent<HTMLDivElement>) {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		const trackEl = trackRef.current;
		const thumbEl = thumbRef.current;
		if (!trackEl || !thumbEl) return;

		const maxThumbTop = Math.max(
			0,
			trackEl.clientHeight - thumbEl.offsetHeight,
		);
		if (maxThumbTop <= 0) return;

		const maxScroll = Math.max(
			0,
			document.documentElement.scrollHeight - window.innerHeight,
		);
		const deltaY = event.clientY - drag.startY;
		const nextScrollTop = Math.min(
			maxScroll,
			Math.max(0, drag.startScrollTop + (deltaY / maxThumbTop) * maxScroll),
		);
		window.scrollTo({ top: nextScrollTop, behavior: "auto" });
		pulseScrolling();
	}

	function handleThumbPointerUp(event: React.PointerEvent<HTMLDivElement>) {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		dragRef.current = null;
		setDragging(false);
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
	}

	return (
		<div
			ref={trackRef}
			aria-hidden="true"
			data-slot="window-scrollbar"
			onMouseDown={(event) => event.preventDefault()}
			onPointerEnter={(event) => {
				if (event.pointerType !== "touch") setHovering(true);
			}}
			onPointerLeave={() => setHovering(false)}
			onPointerDown={handleTrackPointerDown}
			className={cn(
				"fixed inset-y-0 right-0 z-40 w-2.5 touch-none p-0.5 select-none transition-opacity duration-200 pointer-coarse:pointer-events-none motion-reduce:transition-none",
				visible ? "opacity-100" : "opacity-0",
			)}
		>
			<div
				ref={thumbRef}
				data-slot="window-scrollbar-thumb"
				onPointerDown={handleThumbPointerDown}
				onPointerMove={handleThumbPointerMove}
				onPointerUp={handleThumbPointerUp}
				onPointerCancel={handleThumbPointerUp}
				className={cn(
					"w-full rounded-full bg-muted-foreground/35 transition-colors hover:bg-muted-foreground/55 motion-reduce:transition-none",
					dragging && "bg-muted-foreground/70",
				)}
			/>
		</div>
	);
}
