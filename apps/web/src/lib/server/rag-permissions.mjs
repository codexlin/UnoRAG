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
	const isAskRequest =
		normalizedMethod === "POST" &&
		pathSegments[0] === "v1" &&
		pathSegments[1] === "ask" &&
		(pathSegments.length === 2 ||
			(pathSegments.length === 3 && pathSegments[2] === "stream"));
	return !isAskRequest;
}

export function isInternalRagPath(pathSegments) {
	return pathSegments[0] === "v1" && pathSegments[1] === "internal";
}

/**
 * L6: browser must not reach FastAPI product write paths via the BFF proxy.
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
