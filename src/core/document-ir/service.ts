import { DocumentIRSchema } from "./schemas";

export type DocumentIRValidationIssue = {
	path: string;
	code: string;
};

export class InvalidDocumentIRError extends Error {
	readonly issues: DocumentIRValidationIssue[];

	constructor(issues: DocumentIRValidationIssue[]) {
		super("invalid DocumentIR");
		this.name = "InvalidDocumentIRError";
		this.issues = issues;
	}
}

export type DocumentIRCharacterization = {
	contractVersion: "document-ir-v1";
	documentId: string;
	nodeCount: number;
	tableCount: number;
	pageCount: number;
	parser: string;
	partial: boolean;
};

export function characterizeDocumentIR(
	input: unknown,
): DocumentIRCharacterization {
	const parsed = DocumentIRSchema.safeParse(input);
	if (!parsed.success) {
		throw new InvalidDocumentIRError(
			parsed.error.issues.map((issue) => ({
				path: issue.path.join("."),
				code: issue.code,
			})),
		);
	}
	const document = parsed.data;
	const pageIntervals: Array<[number, number]> = [];
	let tableCount = 0;

	for (const node of document.nodes) {
		if (node.type === "table") tableCount += 1;
		if (node.page_start !== null) {
			pageIntervals.push([
				node.page_start,
				Math.max(node.page_start, node.page_end ?? node.page_start),
			]);
		}
	}

	return {
		contractVersion: "document-ir-v1",
		documentId: document.id,
		nodeCount: document.nodes.length,
		tableCount,
		pageCount: countCoveredPages(pageIntervals),
		parser: document.parser_report.parser,
		partial: document.parser_report.partial,
	};
}

function countCoveredPages(intervals: Array<[number, number]>): number {
	if (intervals.length === 0) return 0;
	const ordered = [...intervals].sort((left, right) => left[0] - right[0]);
	let [start, end] = ordered[0];
	let count = 0;

	for (const [nextStart, nextEnd] of ordered.slice(1)) {
		if (nextStart <= end + 1) {
			end = Math.max(end, nextEnd);
			continue;
		}
		count += end - start + 1;
		start = nextStart;
		end = nextEnd;
	}

	return count + end - start + 1;
}
