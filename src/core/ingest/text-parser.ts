import { type DocumentIR, DocumentIRSchema } from "../document-ir";
import { parseMarkdownTable } from "../parsing/markdown-table";

export type ParseTextDocumentInput = {
	documentId: string;
	libraryId: string;
	filename: string;
	contentHash: string;
	content: Uint8Array;
	source?: string;
	sourceFormat?: "txt" | "md" | "markdown";
};

type PendingNode = {
	type: "paragraph" | "list";
	lines: string[];
	path: string | null;
};

class TextDocumentParseError extends Error {
	readonly retryable = false;

	constructor(
		message: string,
		readonly code: "document_ingest_empty" | "document_parse_invalid",
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "TextDocumentParseError";
	}
}

/**
 * Native UTF-8 parser used by the first DBOS ingest canary. It intentionally
 * handles text only; binary formats remain behind ParserProvider.
 */
export function parseTextDocument(input: ParseTextDocumentInput): DocumentIR {
	requireValue(input.documentId, "documentId");
	requireValue(input.libraryId, "libraryId");
	requireValue(input.filename, "filename");
	requireValue(input.contentHash, "contentHash");
	if (input.content.byteLength === 0) {
		throw new TextDocumentParseError(
			"text document is empty",
			"document_ingest_empty",
		);
	}

	let decoded: string;
	try {
		decoded = new TextDecoder("utf-8", { fatal: true }).decode(input.content);
	} catch (error) {
		throw new TextDocumentParseError(
			"text document is not valid UTF-8",
			"document_parse_invalid",
			{ cause: error },
		);
	}
	if (decoded.includes("\0")) {
		throw new TextDocumentParseError(
			"text document contains binary NUL bytes",
			"document_parse_invalid",
		);
	}
	const text = decoded.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	if (!text.trim()) {
		throw new TextDocumentParseError(
			"text document has no readable content",
			"document_ingest_empty",
		);
	}

	const headings: string[] = [];
	const nodes: Array<Record<string, unknown>> = [];
	let pending: PendingNode | undefined;
	let sequence = 0;
	const currentPath = () => headings.filter(Boolean).join("/") || null;
	const flush = () => {
		if (!pending) return;
		const body = pending.lines.join("\n").trim();
		if (body) {
			nodes.push({
				id: `text-${pending.type}-${sequence}`,
				type: pending.type,
				path: pending.path,
				text: body,
				meta: { source_line_group: sequence },
			});
			sequence += 1;
		}
		pending = undefined;
	};

	const lines = text.split("\n");
	const markdown =
		input.sourceFormat === "md" || input.sourceFormat === "markdown";
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex].trimEnd();
		const fence = markdown ? /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line) : null;
		if (fence && (fence[1][0] !== "`" || !fence[2].includes("`"))) {
			flush();
			const start = lineIndex;
			while (++lineIndex < lines.length) {
				const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(lines[lineIndex]);
				if (
					closing &&
					closing[1][0] === fence[1][0] &&
					closing[1].length >= fence[1].length
				)
					break;
			}
			nodes.push({
				id: `text-code-${sequence}`,
				type: "code",
				path: currentPath(),
				text: lines.slice(start, lineIndex + 1).join("\n"),
				meta: { source_line_group: sequence },
			});
			sequence += 1;
			continue;
		}
		const heading = /^(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
		if (heading) {
			flush();
			const level = heading[1]?.length ?? 1;
			const title = heading[2]?.trim() ?? "";
			if (!title) continue;
			headings.splice(level - 1);
			headings[level - 1] = title;
			const path = headings.filter(Boolean).join("/");
			nodes.push({
				id: `text-heading-${sequence}`,
				type: "heading",
				path,
				level,
				text: title,
				meta: { source_line_group: sequence },
			});
			sequence += 1;
			continue;
		}
		const table = markdown
			? parseMarkdownTable({
					lines,
					startLine: lineIndex,
					tableId: `${input.documentId}:table:${lineIndex + 1}`,
					caption: headings.filter(Boolean).at(-1) ?? "",
				})
			: null;
		if (table) {
			flush();
			nodes.push({
				id: `text-${table.tableIr ? "table" : "paragraph"}-${sequence}`,
				type: table.tableIr ? "table" : "paragraph",
				path: currentPath(),
				text: lines.slice(lineIndex, table.endLine).join("\n"),
				table_id: table.tableIr?.table_id ?? null,
				table_ir: table.tableIr,
				meta: { source_line_group: sequence },
			});
			sequence += 1;
			lineIndex = table.endLine - 1;
			continue;
		}
		if (!line.trim()) {
			flush();
			continue;
		}
		const type = isListLine(line) ? "list" : "paragraph";
		const path = currentPath();
		if (pending && (pending.type !== type || pending.path !== path)) flush();
		pending ??= { type, lines: [], path };
		pending.lines.push(line.trim());
	}
	flush();
	if (nodes.length === 0) {
		throw new TextDocumentParseError(
			"text document has no readable nodes",
			"document_ingest_empty",
		);
	}

	return DocumentIRSchema.parse({
		id: input.documentId,
		library_id: input.libraryId,
		source: input.source ?? `storage://${input.filename}`,
		source_format: input.sourceFormat ?? "txt",
		title: titleFromFilename(input.filename),
		filename: input.filename,
		content_hash: input.contentHash,
		nodes,
		parser_report: {
			source_format: input.sourceFormat ?? "txt",
			parser: "native-text",
			backend: "typescript",
			parser_version: markdown ? "2" : "1",
			mode: "native",
			text_pages: [],
			metrics: {
				node_count: nodes.length,
				heading_count: nodes.filter((node) => node.type === "heading").length,
			},
		},
		meta: {
			encoding: "utf-8",
			line_count: lines.length,
		},
	});
}

function isListLine(line: string): boolean {
	return /^\s*(?:[-*+]|\d+[.)]|[（(]?[一二三四五六七八九十]+[）)、.])\s+/.test(
		line,
	);
}

function titleFromFilename(filename: string): string {
	const basename = filename.trim().split(/[\\/]/).at(-1) ?? filename;
	return basename.replace(/\.(?:txt|md|markdown)$/i, "").trim() || basename;
}

function requireValue(value: string, name: string): void {
	if (!value.trim()) throw new Error(`${name} is required`);
}
