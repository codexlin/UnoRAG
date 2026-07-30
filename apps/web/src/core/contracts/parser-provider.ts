import type { DocumentIR, ParserReport } from "../document-ir";

export type ParserCapabilities = {
	formats: readonly string[];
	ocr: boolean;
	tables: boolean;
	figures: boolean;
	boundingBoxes: boolean;
	asynchronous: boolean;
	externalDataProcessing: boolean;
};

export type ParseInput = {
	documentId: string;
	filename: string;
	mimeType: string;
	contentHash: string;
	sourceUri: string;
};

export type ParseOptions = {
	languageHints?: string[];
	pageRange?: { start: number; end: number };
	externalParserAllowed: boolean;
	tier?: string;
	parserVersion?: string;
};

export type DocumentAnalysis = {
	pageCount?: number;
	hasTextLayer: boolean;
	needsOcr: boolean;
	hasTables: boolean;
	hasFigures: boolean;
	complexityScore: number;
	warnings: string[];
};

export type ParseSubmission = {
	providerTaskId: string;
	status: "pending" | "running" | "completed";
	submittedAt: string;
};

export type ProviderTask = {
	providerTaskId: string;
	documentId: string;
};

export type ParseProgress = {
	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	completedPages?: number;
	totalPages?: number;
	retryAfterMs?: number;
	errorCode?: string;
};

export type ParseResult = {
	document: DocumentIR;
	report: ParserReport;
	rawArtifactRef?: string;
};

export interface ParserProvider {
	readonly name: string;
	readonly version: string;
	readonly capabilities: ParserCapabilities;

	analyze(input: ParseInput): Promise<DocumentAnalysis>;
	submit(input: ParseInput, options: ParseOptions): Promise<ParseSubmission>;
	poll(task: ProviderTask): Promise<ParseProgress>;
	fetchResult(task: ProviderTask): Promise<ParseResult>;
	cancel(task: ProviderTask): Promise<void>;
}
