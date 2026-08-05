import type { ApiCitation, ApiRetrievalDebug } from "@/lib/api";
import type { UiCitation, UiTurn } from "@/lib/ui-types";

export type LocalTurn = UiTurn & {
	pending?: boolean;
	error?: string;
	cancelled?: boolean;
	topScore?: number | null;
	usedHybrid?: boolean;
	evidenceReady?: boolean;
	hybridFailed?: boolean;
	rerankFailed?: boolean;
	retrievalMode?: string;
	persisted?: boolean;
	persistError?: string | null;
	startedAtMs?: number;
	startedAt?: number;
	completedAt?: number;
	durationMs?: number;
	evidenceMs?: number;
	retrieveMs?: number;
};

type MetaPatch = Pick<
	LocalTurn,
	| "refused"
	| "refuseReason"
	| "mode"
	| "hybridFailed"
	| "rerankFailed"
	| "retrievalMode"
>;

export type AskTurnsAction =
	| { type: "hydrate"; turns: LocalTurn[] }
	| {
			type: "begin";
			turn: LocalTurn;
			replaceTurnId?: string;
	  }
	| { type: "meta"; turnId: string; patch: MetaPatch }
	| {
			type: "citations";
			turnId: string;
			citations: UiCitation[];
			evidenceMs: number;
	  }
	| { type: "token"; turnId: string; token: string }
	| { type: "complete"; turnId: string; turn: LocalTurn }
	| {
			type: "terminal";
			turnId: string;
			completedAt: number;
			durationMs: number;
			cancelled: boolean;
			error?: string;
	  };

export function askTurnsReducer(
	turns: LocalTurn[],
	action: AskTurnsAction,
): LocalTurn[] {
	switch (action.type) {
		case "hydrate":
			return action.turns;
		case "begin":
			return action.replaceTurnId
				? turns.map((turn) =>
						turn.id === action.replaceTurnId ? action.turn : turn,
					)
				: [...turns, action.turn];
		case "meta":
			return patchTurn(turns, action.turnId, action.patch);
		case "citations":
			return turns.map((turn) =>
				turn.id === action.turnId
					? {
							...turn,
							citations: action.citations,
							evidenceReady: true,
							evidenceMs: turn.evidenceMs ?? action.evidenceMs,
						}
					: turn,
			);
		case "token":
			return turns.map((turn) =>
				turn.id === action.turnId
					? { ...turn, answer: `${turn.answer}${action.token}`, pending: true }
					: turn,
			);
		case "complete":
			return turns.map((turn) =>
				turn.id === action.turnId
					? { ...action.turn, evidenceMs: turn.evidenceMs }
					: turn,
			);
		case "terminal":
			return turns.map((turn) =>
				turn.id === action.turnId
					? {
							...turn,
							id: `turn-${action.completedAt}`,
							pending: false,
							cancelled: action.cancelled,
							error: action.error,
							completedAt: action.completedAt,
							durationMs: action.durationMs,
						}
					: turn,
			);
	}
}

function patchTurn(
	turns: LocalTurn[],
	turnId: string,
	patch: Partial<LocalTurn>,
): LocalTurn[] {
	return turns.map((turn) =>
		turn.id === turnId ? { ...turn, ...patch } : turn,
	);
}

export function toUiCitation(citation: ApiCitation): UiCitation {
	const text = citation.body || citation.text || citation.snippet || "";
	return {
		id: citation.id,
		index: citation.index,
		title: citation.title,
		page: citation.page ?? undefined,
		sectionPath: citation.section_path ?? undefined,
		preamble: citation.preamble ?? undefined,
		snippet: citation.snippet || text.slice(0, 280),
		text,
		score: citation.score,
		denseScore: citation.dense_score,
		bm25Score: citation.bm25_score,
		rrfScore: citation.rrf_score,
		usedRerank: Boolean(citation.used_rerank),
		usedHybrid: Boolean(citation.used_hybrid),
		docId: citation.doc_id ?? undefined,
		chunkIndex: citation.chunk_index ?? undefined,
		filename: citation.filename ?? undefined,
	};
}

export function toApiCitation(citation: UiCitation): ApiCitation {
	return {
		id: citation.id,
		index: citation.index,
		title: citation.title,
		page: citation.page ?? null,
		section_path: citation.sectionPath ?? null,
		preamble: citation.preamble ?? null,
		snippet: citation.snippet || citation.text.slice(0, 280),
		text: citation.text,
		score: citation.score ?? 0,
		dense_score: citation.denseScore ?? null,
		bm25_score: citation.bm25Score ?? null,
		rrf_score: citation.rrfScore ?? null,
		used_rerank: Boolean(citation.usedRerank),
		used_hybrid: Boolean(citation.usedHybrid),
		doc_id: citation.docId ?? null,
		chunk_index: citation.chunkIndex ?? null,
		filename: citation.filename ?? null,
	};
}

export function completedTurn(input: {
	id: string;
	question: string;
	answer: string;
	citations: UiCitation[];
	refused: boolean;
	refuseReason?: string | null;
	mode: string;
	startedAt: number;
	completedAt: number;
	durationMs: number;
	retrieveMs?: number;
	debug: ApiRetrievalDebug;
	hybridFailed: boolean;
	rerankFailed: boolean;
	retrievalMode?: string;
	persisted: boolean;
	persistError?: string | null;
}): LocalTurn {
	return {
		id: input.id,
		question: input.question,
		answer: input.answer,
		citations: input.citations,
		refused: input.refused,
		refuseReason: input.refuseReason,
		mode: input.mode,
		pending: false,
		cancelled: false,
		evidenceReady: true,
		startedAt: input.startedAt,
		completedAt: input.completedAt,
		durationMs: input.durationMs,
		retrieveMs: input.retrieveMs,
		retrievalDebug: input.debug,
		topScore:
			typeof input.debug.top_score === "number" ? input.debug.top_score : null,
		usedHybrid: Boolean(input.debug.used_hybrid),
		hybridFailed: input.hybridFailed,
		rerankFailed: input.rerankFailed,
		retrievalMode: input.retrievalMode,
		persisted: input.persisted,
		persistError: input.persistError ?? null,
	};
}
