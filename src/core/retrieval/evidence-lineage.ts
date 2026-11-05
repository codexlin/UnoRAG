function nonemptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function stringValues(value: unknown): string[] {
	return Array.isArray(value) ? value.filter(nonemptyString) : [];
}

export function sharesEvidenceLineage(
	selected: Record<string, unknown>,
	authoritative: Record<string, unknown>,
): boolean {
	for (const key of ["doc_id", "document_version_id"] as const) {
		if (
			!nonemptyString(selected[key]) ||
			selected[key] !== authoritative[key]
		) {
			return false;
		}
	}
	for (const key of [
		"tenant_id",
		"workspace_id",
		"library_id",
		"generation_id",
	] as const) {
		if (selected[key] == null || authoritative[key] == null) continue;
		if (
			!nonemptyString(selected[key]) ||
			selected[key] !== authoritative[key]
		) {
			return false;
		}
	}
	for (const key of ["table_id", "figure_id"] as const) {
		if (nonemptyString(selected[key]) && selected[key] === authoritative[key]) {
			return true;
		}
	}
	const selectedSources = stringValues(selected.source_chunk_ids);
	const authoritativeSources = stringValues(authoritative.source_chunk_ids);
	if (
		(nonemptyString(selected.record_id) &&
			authoritativeSources.includes(selected.record_id)) ||
		(nonemptyString(authoritative.record_id) &&
			selectedSources.includes(authoritative.record_id))
	) {
		return true;
	}
	const selectedNodes = new Set(stringValues(selected.source_node_ids));
	return stringValues(authoritative.source_node_ids).some((node) =>
		selectedNodes.has(node),
	);
}
