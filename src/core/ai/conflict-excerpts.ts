import { EvidenceAssessmentValidationError } from "./evidence-assessment-diagnostics";

const MAX_EXCERPT_LENGTH = 600;
const sentences = new Intl.Segmenter("und", { granularity: "sentence" });

function splitExcerpts(text: string): string[] {
	const parts: string[] = [];
	let pending = "";
	for (const { segment } of sentences.segment(text)) {
		if (pending.length + segment.length > MAX_EXCERPT_LENGTH && pending) {
			parts.push(pending);
			pending = "";
		}
		let rest = segment;
		while (rest.length > MAX_EXCERPT_LENGTH) {
			let end = MAX_EXCERPT_LENGTH;
			// Do not divide an astral character between UTF-16 code units.
			if (/[\uD800-\uDBFF]/u.test(rest[end - 1])) end--;
			parts.push(rest.slice(0, end));
			rest = rest.slice(end);
		}
		pending += rest;
	}
	if (pending) parts.push(pending);
	return parts.map((part) => part.trim()).filter(Boolean);
}

/** One request-local catalog; the model selects references, never writes quotations. */
export function createConflictExcerpts(citations: readonly unknown[]) {
	const byId = new Map<string, { evidence_id: string; quote: string }>();
	const seenSources = new Set<string>();
	const encoded = citations.map<
		Record<string, unknown> & { excerpts: Array<{ id: string; text: string }> }
	>((value) => {
		const source = value as Record<string, unknown> | null;
		if (
			!source ||
			typeof source.id !== "string" ||
			!source.id ||
			seenSources.has(source.id) ||
			typeof source.text !== "string"
		)
			throw new EvidenceAssessmentValidationError("conflict_unknown_source");
		seenSources.add(source.id);
		const { text, body: _body, snippet: _snippet, ...metadata } = source;
		const excerpts = splitExcerpts(text).map((quote) => {
			const id = `s${byId.size + 1}`;
			byId.set(id, { evidence_id: source.id as string, quote });
			return { id, text: quote };
		});
		if (!excerpts.length)
			throw new EvidenceAssessmentValidationError("conflict_unknown_source");
		return { ...metadata, excerpts };
	});
	return {
		citations: encoded,
		has: (id: string) => byId.has(id),
		resolve: (id: string) => {
			const excerpt = byId.get(id);
			if (!excerpt)
				throw new EvidenceAssessmentValidationError("conflict_unknown_source");
			return { ...excerpt };
		},
	};
}
