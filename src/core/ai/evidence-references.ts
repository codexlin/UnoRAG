import { EvidenceAssessmentValidationError } from "./evidence-assessment-diagnostics";

export type EvidenceReferences = Readonly<{
	encodeCitations(citations: readonly unknown[]): unknown[];
	encodeId(canonicalId: string): string;
	decodeId(reference: string): string | undefined;
}>;

/** References belong to one assessment; subsets must retain the original numbering. */
export function createEvidenceReferences(
	citations: readonly unknown[],
): EvidenceReferences {
	const byCitation = new Map<unknown, string>();
	const byCanonicalId = new Map<string, string>();
	const byReference = new Map<string, string>();
	citations.forEach((source, index) => {
		const id = (source as { id?: unknown } | null)?.id;
		if (typeof id !== "string" || !id) return;
		const reference = `e${index + 1}`;
		byCitation.set(source, reference);
		byReference.set(reference, id);
		if (!byCanonicalId.has(id)) byCanonicalId.set(id, reference);
	});
	return {
		encodeCitations: (sources) =>
			sources.map((source) =>
				source !== null && typeof source === "object"
					? { ...source, id: byCitation.get(source) }
					: source,
			),
		encodeId: (id) => {
			const reference = byCanonicalId.get(id);
			if (!reference)
				throw new EvidenceAssessmentValidationError("selected_ids_unknown");
			return reference;
		},
		decodeId: (reference) => byReference.get(reference),
	};
}
