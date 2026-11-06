import { z } from "zod";
import type { DocumentIR } from "./schemas";

const MAX_HEADINGS = 256;
const MAX_OUTLINE_CHARS = 12_000;

export const DocumentContextSchema = z
	.object({
		version: z.literal(1),
		title: z.string().max(512),
		filename: z.string().max(512),
		identifiers: z.array(z.string().min(1).max(128)).max(32),
		identifiers_complete: z.boolean(),
		outline_complete: z.boolean(),
		outline: z
			.array(
				z.object({
					node_id: z.string().min(1),
					text: z.string().min(1).max(512),
					level: z.number().int().min(1).max(6),
					page: z.number().int().positive().nullable(),
				}),
			)
			.max(MAX_HEADINGS),
	})
	.strict();

export type DocumentContext = z.infer<typeof DocumentContextSchema>;

/** Preserve parser structure, including headings with no body chunks. */
export function buildDocumentContext(document: DocumentIR): DocumentContext {
	const headings = document.nodes.filter((node) => node.type === "heading");
	const outline: DocumentContext["outline"] = [];
	const parsingComplete =
		!document.parser_report.partial &&
		document.parser_report.failed_pages.length === 0 &&
		document.parser_report.needs_ocr_pages.length === 0 &&
		document.parser_report.vlm_pending_pages.length === 0;
	let complete = parsingComplete;
	let chars = 0;
	for (const node of headings) {
		const text = node.text.trim();
		if (
			!text ||
			text.length > 512 ||
			!node.level ||
			node.level > 6 ||
			outline.length >= MAX_HEADINGS ||
			chars + text.length > MAX_OUTLINE_CHARS
		) {
			complete = false;
			continue;
		}
		chars += text.length;
		outline.push({
			node_id: node.id,
			text,
			level: node.level,
			page: node.page_start,
		});
	}
	const identifiers = new Set<string>();
	let identifiersComplete = parsingComplete;
	// An arbitrary SKU or number in prose is not a document identity.
	const label =
		/(?:文件编号|文档编号|制度编号|规程编号|合同编号|文号|^编号|document\s*(?:id|no\.?|number))(?:\s*[:：]\s*|\s+)([A-Z0-9][A-Z0-9._/-]{2,127})(?![A-Z0-9._/-])/gim;
	for (const node of document.nodes) {
		if (node.type !== "paragraph" && node.type !== "heading") continue;
		for (const match of node.text.matchAll(label)) {
			const id = (match[1] ?? "").toUpperCase();
			if (identifiers.size < 32 || identifiers.has(id)) identifiers.add(id);
			else identifiersComplete = false;
		}
	}
	return DocumentContextSchema.parse({
		version: 1,
		filename: document.filename.trim().slice(0, 512),
		title: (
			headings.find((node) => node.level === 1)?.text ||
			document.title ||
			document.filename
		)
			.trim()
			.slice(0, 512),
		identifiers: [...identifiers],
		identifiers_complete: identifiersComplete,
		outline_complete: complete,
		outline,
	});
}

export function documentContextText(context: DocumentContext): string {
	return [
		context.title,
		...context.identifiers.map((id) => `文件编号：${id}`),
		context.outline_complete
			? "解析目录（完整）："
			: "解析目录（不完整，不可用于完整枚举）：",
		...context.outline.map(
			(heading) => `${"#".repeat(heading.level)} ${heading.text}`,
		),
	].join("\n");
}
