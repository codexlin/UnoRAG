import path from "node:path";

/** Resolve a stable content-type for a lifecycle upload/replace. */
export function contentTypeForUpload(file) {
	const provided = (file.type || "").trim();
	if (provided && provided.toLowerCase() !== "application/octet-stream") {
		return provided;
	}
	const extension = path.extname(file.name || "").toLowerCase();
	return (
		{
			".txt": "text/plain",
			".md": "text/markdown",
			".markdown": "text/markdown",
			".pdf": "application/pdf",
			".docx":
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		}[extension] || "application/octet-stream"
	);
}

/** Next monotonic version number given the current max (null/undefined => 1). */
export function nextDocumentVersionNumber(currentMax) {
	const max = Number(currentMax);
	if (!Number.isFinite(max) || max < 0) return 1;
	return Math.floor(max) + 1;
}

/** Enqueue-time ingest slot: pdf→auto (probe later), else local. */
export function inferIngestQueueClass(filename, contentType) {
	const name = String(filename || "")
		.trim()
		.toLowerCase();
	const ctype = String(contentType || "")
		.trim()
		.toLowerCase();
	if (name.endsWith(".pdf") || ctype.includes("pdf")) {
		return "auto";
	}
	return "local";
}

/** Build the document.ingest job payload shared by upload and replace. */
export function buildDocumentIngestPayload(input) {
	return {
		document_id: input.documentId,
		document_version_id: input.versionId,
		generation_id: input.generationId,
		library_id: input.ragLibraryId,
		storage_key: input.storageKey,
		content_hash: input.contentHash,
		filename: input.filename,
		content_type: input.contentType,
		// local | auto | mineru — worker claims by class so MinerU cannot starve docx
		queue_class: inferIngestQueueClass(input.filename, input.contentType),
	};
}

export function documentIngestIdempotencyKey(versionId, generationId) {
	return `document.ingest:${versionId}:${generationId}:document-lifecycle-v2`;
}
