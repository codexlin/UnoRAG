import type { AuthorizedScope, RetrievalFilters } from "@/core/contracts";
import {
	DocumentContextSchema,
	documentContextText,
} from "@/core/document-ir/document-context";
import type {
	DefaultRetrievalService,
	InternalCitation,
} from "@/core/retrieval";
import {
	type ActiveDocumentCatalog,
	type ActiveDocumentDescriptor,
	executeOutlineQuestion,
	needsDocumentConstraint,
	resolveDocumentConstraint,
} from "@/core/retrieval/document-constraints";

export type DocumentEvidenceResolution = {
	status:
		| "none"
		| "resolved"
		| "unavailable"
		| "ambiguous"
		| "outline_unavailable";
	scope: AuthorizedScope;
	documents: ActiveDocumentDescriptor[];
	outline?: { text: string; citation: InternalCitation };
};

/** Project validated identity metadata for one exact document generation. */
export function evidenceDocumentContext(
	citation: Pick<InternalCitation, "doc_id" | "generation_id">,
	documents: ActiveDocumentDescriptor[],
): { title: string; filename: string; identifiers: string[] } | null {
	if (
		typeof citation.doc_id !== "string" ||
		!citation.doc_id.trim() ||
		typeof citation.generation_id !== "string" ||
		!citation.generation_id.trim()
	)
		return null;
	const matches = documents.filter(
		(document) =>
			document.documentId === citation.doc_id &&
			document.generationId === citation.generation_id,
	);
	if (matches.length !== 1) return null;
	const context = DocumentContextSchema.safeParse(matches[0]?.context);
	if (!context.success) return null;
	return {
		title: context.data.title,
		filename: context.data.filename,
		identifiers: [...context.data.identifiers],
	};
}

/** The short-path default selects prose hits; exact outline execution replans it. */
export function documentEvidenceFilters(
	planFilters?: RetrievalFilters,
): RetrievalFilters | undefined {
	return planFilters?.record_type === "text"
		? { ...planFilters, record_type: undefined }
		: planFilters;
}

export async function resolveAskDocumentEvidence(input: {
	question: string;
	libraryId: string;
	scope: AuthorizedScope;
	filters?: RetrievalFilters;
	loadCatalog: () => Promise<ActiveDocumentCatalog>;
	lookupDocumentRecord: DefaultRetrievalService["lookupDocumentRecord"];
	signal?: AbortSignal;
}): Promise<DocumentEvidenceResolution> {
	const empty = { scope: input.scope, documents: [] };
	if (!needsDocumentConstraint(input.question))
		return { ...empty, status: "none" };
	input.signal?.throwIfAborted();
	const catalog = await input.loadCatalog();
	input.signal?.throwIfAborted();
	const constraint = resolveDocumentConstraint(
		input.question,
		catalog.documents,
		catalog.complete,
		catalog.completeForQuestion,
	);
	if (constraint.status !== "resolved")
		return { ...empty, status: constraint.status };
	const ids = constraint.documents.map((doc) => doc.documentId);
	if (
		constraint.documents.some(
			(doc) =>
				!input.scope.activeGenerationIds.includes(doc.generationId) ||
				(input.scope.documentIds &&
					!input.scope.documentIds.includes(doc.documentId)) ||
				(input.filters?.doc_id && input.filters.doc_id !== doc.documentId),
		)
	) {
		return { ...empty, status: "unavailable" };
	}
	const scope = {
		...input.scope,
		documentIds: ids,
		activeGenerationIds: [
			...new Set(constraint.documents.map((doc) => doc.generationId)),
		],
	};
	const resolution: DocumentEvidenceResolution = {
		status: "resolved",
		scope,
		documents: constraint.documents,
	};
	if (!constraint.outlineLevel) return resolution;
	const text = executeOutlineQuestion(input.question, constraint);
	const doc = constraint.documents[0];
	const citation =
		text && doc?.context
			? await input.lookupDocumentRecord({
					libraryId: input.libraryId,
					scope,
					documentId: doc.documentId,
					generationId: doc.generationId,
					expectedBody: documentContextText(doc.context),
					filters: input.filters,
					signal: input.signal,
				})
			: null;
	if (!text || !citation)
		return { ...resolution, status: "outline_unavailable" };
	return { ...resolution, outline: { text, citation } };
}
