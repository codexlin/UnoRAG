export function buildDocumentDeletePayload(input: {
	documentId: string;
	ragDocumentId: string;
	libraryId: string;
	ragLibraryId: string;
	storageKeys?: string[];
	generationIds?: string[];
	libraryDelete?: boolean;
}): {
	document_id: string;
	rag_document_id: string;
	library_id: string;
	rag_library_id: string;
	storage_keys: string[];
	generation_ids: string[];
	library_delete: boolean;
};

export function documentDeleteIdempotencyKey(documentId: string): string;
