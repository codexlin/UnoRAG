/** Shared UI types for ask / evidence panels (not demo fixtures). */

export type MockLibrary = {
	id: string;
	name: string;
	docCount: number;
	readyCount: number;
	updatedAt: string;
	status: "ready" | "indexing" | "empty";
};

export type MockCitation = {
	id: string;
	index: number;
	title: string;
	page?: string;
	snippet: string;
	score: number;
	docId?: string;
	chunkIndex?: number;
	filename?: string;
};

export type MockTurn = {
	id: string;
	question: string;
	answer: string;
	citations: MockCitation[];
	refused?: boolean;
	refuseReason?: string | null;
	mode?: string;
};
