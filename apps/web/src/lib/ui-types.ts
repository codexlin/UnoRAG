/** Shared UI types for ask / evidence panels (not demo fixtures). */

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
	score: number;
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
};
