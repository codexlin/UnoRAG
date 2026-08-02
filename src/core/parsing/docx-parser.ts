import { DomUtils, parseDocument } from "htmlparser2";
import mammoth from "mammoth";

import {
	type DocumentIR,
	DocumentIRSchema,
	type DocumentNode,
	NodeSchema,
} from "../document-ir";
import { normalizeHtmlTable } from "./html-table";

export type ParseDocxDocumentInput = {
	documentId: string;
	libraryId: string;
	filename: string;
	title: string;
	contentHash: string;
	content: Uint8Array;
	source: string;
};

type HtmlNode = ReturnType<typeof parseDocument>["children"][number];
type HtmlElement = HtmlNode & { name: string; children: HtmlNode[] };

export async function parseDocxDocument(
	input: ParseDocxDocumentInput,
): Promise<DocumentIR> {
	if (input.content.byteLength === 0) throw new Error("DOCX document is empty");
	const converted = await mammoth.convertToHtml({
		buffer: Buffer.from(input.content),
	});
	const root = parseDocument(converted.value);
	const html = root.children.find(
		(node) => isElement(node) && node.name === "html",
	);
	const body =
		html && isElement(html)
			? html.children.find((node) => isElement(node) && node.name === "body")
			: undefined;
	const containerChildren =
		body && isElement(body)
			? body.children
			: html && isElement(html)
				? html.children
				: root.children;
	const nodes: DocumentNode[] = [];
	const headings: string[] = [];
	let sequence = 0;
	let tableSequence = 0;

	const append = (node: Omit<DocumentNode, "id">) => {
		nodes.push(
			NodeSchema.parse({
				...node,
				id: `${input.documentId}:docx:${sequence}`,
			}),
		);
		sequence += 1;
	};

	for (const child of containerChildren) {
		if (!isElement(child)) continue;
		const tag = child.name.toLowerCase();
		const text = normalizedText(child);
		if (/^h[1-6]$/.test(tag) && text) {
			const level = Number(tag.slice(1));
			headings.splice(level - 1);
			headings[level - 1] = text;
			append(nodeFields("heading", text, currentPath(headings), { level }));
			continue;
		}
		if (tag === "table") {
			const tableId = `${input.documentId}:table:${tableSequence}`;
			const table = normalizeHtmlTable({
				html: DomUtils.getOuterHTML(child),
				tableId,
			});
			if (!table) continue;
			tableSequence += 1;
			append({
				...nodeFields("table", table.text, currentPath(headings)),
				table_json: { headers: table.headers, rows: table.rows },
				table_ir: table.tableIr,
				table_id: tableId,
				confidence: 0.9,
			});
			continue;
		}
		if ((tag === "ul" || tag === "ol") && text) {
			const items = child.children
				.filter((node) => isElement(node) && node.name === "li")
				.map(normalizedText)
				.filter(Boolean);
			if (items.length > 0) {
				append(nodeFields("list", items.join("\n"), currentPath(headings)));
			}
			continue;
		}
		if (tag === "p" && text) {
			append(nodeFields("paragraph", text, currentPath(headings)));
		}
	}
	if (nodes.length === 0)
		throw new Error("DOCX document has no readable nodes");
	return DocumentIRSchema.parse({
		id: input.documentId,
		library_id: input.libraryId,
		source: input.source,
		source_format: "docx",
		title: input.title,
		filename: input.filename,
		content_hash: input.contentHash,
		nodes,
		parser_report: {
			source_format: "docx",
			parser: "mammoth",
			backend: "typescript",
			parser_version: "1.10.0",
			mode: "structured",
			warnings: converted.messages.map((message) => message.message),
			partial: converted.messages.some((message) => message.type === "warning"),
			metrics: {
				node_count: nodes.length,
				heading_count: nodes.filter((node) => node.type === "heading").length,
				table_count: nodes.filter((node) => node.type === "table").length,
			},
		},
		meta: {},
	});
}

function nodeFields(
	type: DocumentNode["type"],
	text: string,
	path: string | null,
	overrides: Partial<Omit<DocumentNode, "id" | "type" | "text" | "path">> = {},
): Omit<DocumentNode, "id"> {
	return {
		type,
		path,
		level: null,
		page_start: null,
		page_end: null,
		text,
		table_json: null,
		table_ir: null,
		figure_desc: null,
		confidence: 1,
		table_id: null,
		figure_id: null,
		meta: {},
		...overrides,
	};
}

function isElement(node: HtmlNode): node is HtmlElement {
	return (
		"name" in node && Array.isArray((node as { children?: unknown }).children)
	);
}

function normalizedText(node: HtmlNode): string {
	return DomUtils.textContent(node).replace(/\s+/g, " ").trim();
}

function currentPath(headings: string[]): string | null {
	const path = headings.filter(Boolean).join("/");
	return path || null;
}
