import path from "node:path";

const COMMON_BINARY_TYPES = new Set(["", "application/octet-stream"]);
const CONTENT_TYPES_BY_EXTENSION = new Map([
	[".txt", new Set([...COMMON_BINARY_TYPES, "text/plain"])],
	[".md", new Set([...COMMON_BINARY_TYPES, "text/markdown", "text/plain"])],
	[
		".markdown",
		new Set([...COMMON_BINARY_TYPES, "text/markdown", "text/plain"]),
	],
	[".pdf", new Set([...COMMON_BINARY_TYPES, "application/pdf"])],
	[
		".docx",
		new Set([
			...COMMON_BINARY_TYPES,
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		]),
	],
]);

export function validateDocumentUpload(file) {
	const extension = path.extname(file.name).toLowerCase();
	const allowedTypes = CONTENT_TYPES_BY_EXTENSION.get(extension);
	if (!allowedTypes) {
		return "supported file types: .txt, .md, .markdown, .pdf, .docx";
	}
	const contentType = (file.type || "").toLowerCase();
	if (!allowedTypes.has(contentType)) {
		return `unsupported content type for ${extension}: ${file.type}`;
	}
	return null;
}
