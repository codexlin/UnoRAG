/**
 * @param {string} method
 * @param {string[]} pathSegments
 */
export function requiresLibraryWritePermission(method, pathSegments) {
	const normalizedMethod = method.toUpperCase();
	if (
		normalizedMethod === "GET" ||
		normalizedMethod === "HEAD" ||
		normalizedMethod === "OPTIONS"
	) {
		return false;
	}
	if (pathSegments[0] !== "v1") return true;

	// Ask + personal session archive/continue are not library mutations.
	const isAskRequest =
		normalizedMethod === "POST" &&
		pathSegments[1] === "ask" &&
		(pathSegments.length === 2 ||
			(pathSegments.length === 3 && pathSegments[2] === "stream"));
	if (isAskRequest) return false;

	const isThreadSessionRequest =
		normalizedMethod === "POST" &&
		pathSegments[1] === "threads" &&
		(pathSegments.length === 2 ||
			(pathSegments.length === 3 && pathSegments[2] !== "") ||
			(pathSegments.length === 4 && pathSegments[3] === "continue"));
	if (isThreadSessionRequest) return false;

	return true;
}

export function isInternalRagPath(pathSegments) {
	return pathSegments[0] === "v1" && pathSegments[1] === "internal";
}

/**
 * Browser requests cannot bypass product RBAC through the internal RAG surface.
 * Ask/stream, archive, download, and health remain allowed.
 *
 * @param {string} method
 * @param {string[]} pathSegments
 */
export function isDeprecatedBrowserRagWritePath(method, pathSegments) {
	if (pathSegments[0] !== "v1") return false;
	const normalizedMethod = method.toUpperCase();
	if (normalizedMethod === "GET" || normalizedMethod === "HEAD") {
		return false;
	}
	if (
		normalizedMethod === "POST" &&
		pathSegments[1] === "ingest" &&
		(pathSegments.length === 2 ||
			(pathSegments.length === 3 && pathSegments[2] === "upload"))
	) {
		return true;
	}
	if (
		normalizedMethod === "POST" &&
		pathSegments[1] === "documents" &&
		pathSegments[2] &&
		(pathSegments[3] === "replace" || pathSegments[3] === "reindex")
	) {
		return true;
	}
	if (
		normalizedMethod === "DELETE" &&
		pathSegments[1] === "documents" &&
		pathSegments[2] &&
		pathSegments.length === 3
	) {
		return true;
	}
	if (
		(normalizedMethod === "POST" ||
			normalizedMethod === "PATCH" ||
			normalizedMethod === "DELETE") &&
		pathSegments[1] === "libraries"
	) {
		return true;
	}
	return false;
}
