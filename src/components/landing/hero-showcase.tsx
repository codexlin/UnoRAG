"use client";

import { useState } from "react";
import {
	EvidenceExplorer,
	type EvidenceView,
} from "@/components/landing/evidence-explorer";
import {
	type ProductFilmChapter,
	ProductFilmPlayer,
} from "@/components/landing/product-film-player";
import { useInterfaceLanguage, useInterfaceText } from "@/lib/i18n/provider";

const CHAPTER_TO_VIEW: Record<string, EvidenceView> = {
	cite: "answer",
	match: "source",
	scope: "trace",
};

const VIEW_TO_CHAPTER: Record<EvidenceView, string> = {
	answer: "cite",
	source: "match",
	trace: "scope",
};

export function HeroShowcase() {
	const { locale } = useInterfaceLanguage();
	const t = useInterfaceText();
	const lang = locale === "zh-CN" ? "zh" : "en";
	const [activeChapter, setActiveChapter] = useState("cite");
	const [evidenceView, setEvidenceView] = useState<EvidenceView>("answer");

	const chapters: readonly ProductFilmChapter[] = [
		{
			id: "cite",
			label: t("引用回答", "Cited answer"),
			shortLabel: t("引用", "Cite"),
			startSec: 0,
		},
		{
			id: "match",
			label: t("检索与核验", "Retrieval & check"),
			shortLabel: t("检索", "Retrieve"),
			startSec: 4,
		},
		{
			id: "scope",
			label: t("权限范围", "Access scope"),
			shortLabel: t("权限", "Scope"),
			startSec: 8,
		},
	];

	function handleChapterSelect(chapterId: string) {
		setActiveChapter(chapterId);
		const mapped = CHAPTER_TO_VIEW[chapterId];
		if (mapped) setEvidenceView(mapped);
	}

	function handleEvidenceViewChange(nextView: EvidenceView) {
		setEvidenceView(nextView);
		setActiveChapter(VIEW_TO_CHAPTER[nextView]);
	}

	return (
		<div className="landing-wrap relative z-10">
			<div className="landing-stage-bezel overflow-hidden rounded-xl border border-border bg-card ring-4 ring-muted/70 sm:ring-[6px]">
				<ProductFilmPlayer
					priority
					light={{
						videoSrc: `/landing-media/hero-${lang}-light.mp4`,
						posterSrc: `/landing-media/hero-${lang}-light.png`,
					}}
					dark={{
						videoSrc: `/landing-media/hero-${lang}-dark.mp4`,
						posterSrc: `/landing-media/hero-${lang}-dark.png`,
					}}
					alt={t(
						"UnoRAG 知识问答动态演示：从带原文引用的回答、混合检索核验到文档权限过滤",
						"UnoRAG workflow demo: cited answer with highlighted source excerpt, hybrid retrieval verification, and document access scoping",
					)}
					aspectClassName="aspect-[16/9]"
					chapters={chapters}
					activeChapterId={activeChapter}
					onChapterSelect={handleChapterSelect}
					onChapterSync={setActiveChapter}
					className="rounded-none border-0 shadow-none"
				/>
				<EvidenceExplorer
					view={evidenceView}
					onViewChange={handleEvidenceViewChange}
					embedded
				/>
			</div>
		</div>
	);
}
