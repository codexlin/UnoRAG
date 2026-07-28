export const ASK_LIBRARY_STORAGE_KEY = "unorag.ask.last_library_id";

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
	if (preferred && selectable.some((library) => library.id === preferred)) {
		return preferred;
	}

	return (
		selectable.find(
			(library) =>
				library.status === "ready" && Number(library.ready_count) > 0,
		)?.id ??
		selectable.find(
			(library) => library.status === "ready" && Number(library.doc_count) > 0,
		)?.id ??
		selectable.find((library) => library.status === "indexing")?.id ??
		selectable.find((library) => library.status === "ready")?.id ??
		selectable.find((library) => library.status !== "empty")?.id ??
		selectable[0]?.id ??
		""
	);
}
