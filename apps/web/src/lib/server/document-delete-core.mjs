/** Build the document.delete job payload shared by document and library delete. */
export function buildDocumentDeletePayload(input) {
	return {
		document_id: input.documentId,
		rag_document_id: input.ragDocumentId,
		library_id: input.libraryId,
		rag_library_id: input.ragLibraryId,
		storage_keys: Array.isArray(input.storageKeys) ? input.storageKeys : [],
		generation_ids: Array.isArray(input.generationIds)
			? input.generationIds
			: [],
		library_delete: Boolean(input.libraryDelete),
	};
}

export function documentDeleteIdempotencyKey(documentId) {
	return `document.delete:${documentId}:document-lifecycle-v2`;
}
