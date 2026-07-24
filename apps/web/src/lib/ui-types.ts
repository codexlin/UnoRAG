/** Shared UI types for ask / evidence panels. */

import type { ApiRetrievalDebug } from "@/lib/api";

export type UiLibrary = {
	id: string;
	name: string;
	docCount: number;
	readyCount: number;
	updatedAt: string;
	status: "ready" | "indexing" | "empty";
};

export type UiCitation = {
	id: string;
	index: number;
	title: string;
	page?: string;
	sectionPath?: string;
	preamble?: string;
	snippet: string;
	/** Chunk body used in LLM context / drawer. */
	text: string;
	/** Final rank score (0–1). */
	score: number;
	denseScore?: number | null;
	bm25Score?: number | null;
	rrfScore?: number | null;
	usedRerank?: boolean;
	usedHybrid?: boolean;
	docId?: string;
	chunkIndex?: number;
	filename?: string;
};

export type UiTurn = {
	id: string;
	question: string;
	answer: string;
	citations: UiCitation[];
	refused?: boolean;
	refuseReason?: string | null;
	mode?: string;
	/** Full ask retrieval_debug from onDone (session-local). */
	retrievalDebug?: ApiRetrievalDebug | null;
};
