export const ASK_LIBRARY_STORAGE_KEY = "unorag.ask.last_library_id";

export function isAskableLibrary(library) {
	return Boolean(
		library &&
			["ready", "degraded", "indexing"].includes(library.status) &&
			Number(library.ready_count) > 0,
	);
}

/**
 * Select the Ask library without letting a newly-created empty library displace
 * useful content. The API returns libraries by updated_at descending, so each
 * find preserves recency within its quality tier.
 *
 * @param {Array<{
 *   id: string,
 *   status?: string,
 *   doc_count?: number,
 *   ready_count?: number,
 * }>} libraries
 * @param {string | null | undefined} preferredId
 */
export function chooseAskLibraryId(libraries, preferredId) {
	const selectable = libraries.filter(
		(library) =>
			library.id &&
			library.status !== "deleted" &&
			library.status !== "deleting",
	);
	const preferred = String(preferredId ?? "").trim();
	const preferredLibrary = selectable.find(
		(library) => library.id === preferred,
	);
	if (
		preferredLibrary &&
		(isAskableLibrary(preferredLibrary) || !selectable.some(isAskableLibrary))
	) {
		return preferred;
	}

	return (
		selectable.find(isAskableLibrary)?.id ??
		selectable.find((library) => library.status === "indexing")?.id ??
		selectable.find((library) => library.status === "ready")?.id ??
		selectable.find((library) => library.status !== "empty")?.id ??
		selectable[0]?.id ??
		""
	);
}
