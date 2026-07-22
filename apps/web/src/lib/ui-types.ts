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
	snippet: string;
	/** Full chunk text used in LLM context. */
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
