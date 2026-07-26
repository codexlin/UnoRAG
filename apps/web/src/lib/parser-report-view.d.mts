export declare const PARSER_REPORT_TITLE: "最新解析报告";
export declare const PARSE_DEGRADED_STATUS_LABEL: "已就绪（降级）";
export declare const PARSE_DEGRADED_REINDEX_HINT: "MinerU 恢复后可重新索引以获得更好效果";

export type ParserReportLike = {
	partial?: boolean;
	failed_pages?: number[];
	needs_ocr_pages?: number[];
	warnings?: string[];
	notes?: string;
	metrics?: Record<string, unknown>;
	[key: string]: unknown;
};

export type ParserReportView = {
	title: string;
	summaries: string[];
	techDetails: string[];
	empty: boolean;
	degraded: boolean;
};

export type DocumentStatusDisplay = {
	label: string;
	tone: string;
	parseDegraded: boolean;
};

export declare function dedupeTechDetails(items: string[]): string[];

export declare function isParserReportDegraded(
	report: ParserReportLike | null | undefined,
): boolean;

export declare function resolveDocumentStatusDisplay(
	status: string,
	parserReport?: ParserReportLike | null,
): DocumentStatusDisplay;

export declare function formatParserReportView(
	report: ParserReportLike | null | undefined,
): ParserReportView;
