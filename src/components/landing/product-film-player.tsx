"use client";

import { Pause, Play } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import Image from "next/image";
import { useTheme } from "next-themes";
import { useEffect, useId, useRef, useState } from "react";
import { useInterfaceText } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

type MediaAsset = {
	videoSrc: string;
	posterSrc: string;
};

export type ProductFilmChapter = {
	id: string;
	label: string;
	shortLabel?: string;
	startSec: number;
};

type ProductFilmPlayerProps = {
	light: MediaAsset;
	dark: MediaAsset;
	alt: string;
	caption?: string;
	aspectClassName?: string;
	className?: string;
	priority?: boolean;
	chapters?: readonly ProductFilmChapter[];
	activeChapterId?: string;
	onChapterSelect?: (chapterId: string) => void;
	onChapterSync?: (chapterId: string) => void;
};

export function ProductFilmPlayer({
	light,
	dark,
	alt,
	caption,
	aspectClassName = "aspect-video",
	className,
	priority = false,
	chapters,
	activeChapterId,
	onChapterSelect,
	onChapterSync,
}: ProductFilmPlayerProps) {
	const t = useInterfaceText();
	const { resolvedTheme } = useTheme();
	const reducedMotion = useReducedMotion();
	const [mounted, setMounted] = useState(false);
	const [paused, setPaused] = useState(false);
	const [inView, setInView] = useState(priority);
	const [failedVideoSrc, setFailedVideoSrc] = useState<string | null>(null);
	const [playbackProgress, setPlaybackProgress] = useState(0);
	const chapterPillId = useId();
	const containerRef = useRef<HTMLDivElement | null>(null);
	const videoRef = useRef<HTMLVideoElement | null>(null);

	useEffect(() => {
		setMounted(true);
	}, []);

	useEffect(() => {
		if (priority || !mounted) return;
		const node = containerRef.current;
		if (!node || typeof IntersectionObserver === "undefined") {
			setInView(true);
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				const visible = entries.some((entry) => entry.isIntersecting);
				setInView(visible);
			},
			{ rootMargin: "140px 0px" },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, [priority, mounted]);

	const isReduced = mounted && Boolean(reducedMotion);
	const isDark = mounted && resolvedTheme === "dark";
	const activeMedia = isDark ? dark : light;
	const videoFailed = failedVideoSrc === activeMedia.videoSrc;
	const showVideo =
		mounted && !isReduced && !videoFailed && (priority || inView);

	// Sync play/pause both when user toggles AND when video remounts on theme/locale switch.
	useEffect(() => {
		const video = videoRef.current;
		if (!video || !showVideo) return;
		if (paused || !inView) {
			video.pause();
		} else {
			void video.play().catch(() => {
				setPaused(true);
			});
		}
	}, [paused, inView, showVideo]);

	// Keep chapter indicator and subtle timeline rail synchronized while playing.
	useEffect(() => {
		const video = videoRef.current;
		if (!video || !chapters?.length || !showVideo) return;
		const syncFromVideo = () => {
			const now = video.currentTime;
			const dur = video.duration;
			if (Number.isFinite(dur) && dur > 0) {
				setPlaybackProgress(Math.min(1, Math.max(0, now / dur)));
			}
			if (onChapterSync) {
				let current = chapters[0].id;
				for (const chapter of chapters) {
					if (now >= chapter.startSec - 0.1) current = chapter.id;
				}
				onChapterSync(current);
			}
		};
		video.addEventListener("timeupdate", syncFromVideo);
		video.addEventListener("seeked", syncFromVideo);
		let rafId = 0;
		const tick = () => {
			if (
				!video.paused &&
				Number.isFinite(video.duration) &&
				video.duration > 0
			) {
				setPlaybackProgress(
					Math.min(1, Math.max(0, video.currentTime / video.duration)),
				);
			}
			rafId = window.requestAnimationFrame(tick);
		};
		if (!paused && inView) {
			rafId = window.requestAnimationFrame(tick);
		}
		return () => {
			video.removeEventListener("timeupdate", syncFromVideo);
			video.removeEventListener("seeked", syncFromVideo);
			if (rafId) window.cancelAnimationFrame(rafId);
		};
	}, [chapters, onChapterSync, showVideo, paused, inView]);

	function seekToChapter(chapter: ProductFilmChapter) {
		onChapterSelect?.(chapter.id);
		const video = videoRef.current;
		if (video && showVideo) {
			video.currentTime = chapter.startSec;
			if (paused) {
				setPaused(false);
			}
		}
	}

	function togglePlayback() {
		const video = videoRef.current;
		if (!video) return;
		if (video.paused) {
			setPaused(false);
			void video.play().catch(() => setPaused(true));
		} else {
			video.pause();
			setPaused(true);
		}
	}

	const showChapterBar = Boolean(chapters && chapters.length > 0 && !isReduced);

	return (
		<figure
			className={cn(
				"overflow-hidden rounded-xl border border-border bg-card shadow-sm",
				className,
			)}
		>
			{showChapterBar && chapters ? (
				<div className="relative flex items-center justify-between gap-2 border-b border-border bg-muted/35 px-3 py-1.5 sm:px-5 sm:py-2">
					<fieldset className="grid min-w-0 flex-1 grid-cols-3 gap-1 sm:flex sm:flex-none sm:items-center">
						<legend className="sr-only">
							{t("演示章节", "Demo chapters")}
						</legend>
						{chapters.map((chapter) => {
							const selected = activeChapterId === chapter.id;
							return (
								<button
									key={chapter.id}
									type="button"
									aria-pressed={selected}
									onClick={() => seekToChapter(chapter)}
									className={cn(
										"relative inline-flex min-h-11 items-center justify-center rounded-md px-2 text-xs font-medium transition-colors duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-9 md:px-3 motion-reduce:transition-none",
										selected
											? "text-foreground"
											: "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
									)}
								>
									{selected ? (
										<motion.span
											layoutId={chapterPillId}
											aria-hidden
											transition={{
												duration: isReduced ? 0 : 0.24,
												ease: [0.22, 1, 0.36, 1],
											}}
											className="absolute inset-0 rounded-md bg-card shadow-2xs ring-1 ring-border"
										/>
									) : null}
									<span className="relative z-10">
										{chapter.shortLabel ? (
											<>
												<span className="sm:hidden">{chapter.shortLabel}</span>
												<span className="hidden sm:inline">
													{chapter.label}
												</span>
											</>
										) : (
											chapter.label
										)}
									</span>
								</button>
							);
						})}
					</fieldset>
					{showVideo ? (
						<button
							type="button"
							onClick={togglePlayback}
							aria-label={
								paused
									? t("继续播放演示", "Play demo")
									: t("暂停演示", "Pause demo")
							}
							className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-200 hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:size-9 motion-reduce:transition-none"
						>
							{paused ? (
								<Play className="size-3.5" aria-hidden />
							) : (
								<Pause className="size-3.5" aria-hidden />
							)}
						</button>
					) : null}
					{showVideo && !isReduced ? (
						<span
							aria-hidden
							className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-transparent"
						>
							<span
								className="block h-full w-full origin-left bg-cite/70"
								style={{ transform: `scaleX(${playbackProgress.toFixed(4)})` }}
							/>
						</span>
					) : null}
				</div>
			) : null}

			<div
				ref={containerRef}
				className={cn(
					"relative w-full overflow-hidden bg-background dark:ring-1 dark:ring-inset dark:ring-white/[0.06]",
					aspectClassName,
				)}
			>
				{/* Always render crisp SSR-safe posters underneath; hide from a11y tree when <video> takes over */}
				<Image
					src={light.posterSrc}
					alt={showVideo ? "" : alt}
					aria-hidden={showVideo || undefined}
					fill
					unoptimized
					loading={priority ? "eager" : "lazy"}
					className="object-cover dark:hidden"
				/>
				<Image
					src={dark.posterSrc}
					alt={showVideo ? "" : alt}
					aria-hidden={showVideo || undefined}
					fill
					unoptimized
					loading={priority ? "eager" : "lazy"}
					className="hidden object-cover dark:block"
				/>

				{showVideo ? (
					<video
						key={activeMedia.videoSrc}
						ref={videoRef}
						src={activeMedia.videoSrc}
						poster={activeMedia.posterSrc}
						autoPlay={!paused}
						muted
						loop
						playsInline
						preload={priority ? "auto" : "metadata"}
						aria-label={alt}
						onLoadedData={(event) => {
							if (paused) event.currentTarget.pause();
						}}
						onError={() => setFailedVideoSrc(activeMedia.videoSrc)}
						className="absolute inset-0 h-full w-full object-cover"
					/>
				) : null}

				{showVideo && (!chapters || chapters.length === 0) ? (
					<button
						type="button"
						onClick={togglePlayback}
						aria-label={
							paused
								? t("继续播放演示", "Play demo")
								: t("暂停演示", "Pause demo")
						}
						className="absolute right-3 bottom-3 inline-flex size-11 items-center justify-center rounded-lg border border-border bg-background/85 text-foreground shadow-xs transition-colors duration-200 hover:bg-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:size-10 motion-reduce:transition-none"
					>
						{paused ? (
							<Play className="size-4" aria-hidden />
						) : (
							<Pause className="size-4" aria-hidden />
						)}
					</button>
				) : null}
			</div>

			{caption || isReduced ? (
				<figcaption className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/25 px-4 py-2.5 text-xs text-muted-foreground sm:px-5">
					<span>
						{caption ??
							t(
								"示例工作区演示：不代表实际响应耗时承诺。",
								"Sample workspace preview; not a latency benchmark.",
							)}
					</span>
					{isReduced ? (
						<span>
							{t(
								"已按系统偏好停用自动动效",
								"Auto-motion paused per system preference",
							)}
						</span>
					) : null}
				</figcaption>
			) : null}
		</figure>
	);
}
