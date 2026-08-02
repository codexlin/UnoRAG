import { type DocumentIR, DocumentIRSchema } from "../document-ir";

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
		throw new Error("text document is empty");
	}

	let decoded: string;
	try {
		decoded = new TextDecoder("utf-8", { fatal: true }).decode(input.content);
	} catch (error) {
		throw new Error("text document is not valid UTF-8", { cause: error });
	}
	if (decoded.includes("\0")) {
		throw new Error("text document contains binary NUL bytes");
	}
	const text = decoded.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	if (!text.trim()) throw new Error("text document has no readable content");

	const headings: string[] = [];
	const nodes: Array<Record<string, unknown>> = [];
	let pending: PendingNode | undefined;
	let sequence = 0;
	const currentPath = () => (headings.length > 0 ? headings.join("/") : null);
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

	for (const rawLine of text.split("\n")) {
		const line = rawLine.trimEnd();
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
	if (nodes.length === 0)
		throw new Error("text document has no readable nodes");

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
			parser_version: "1",
			mode: "native",
			text_pages: [],
			metrics: {
				node_count: nodes.length,
				heading_count: nodes.filter((node) => node.type === "heading").length,
			},
		},
		meta: {
			encoding: "utf-8",
			line_count: text.split("\n").length,
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
