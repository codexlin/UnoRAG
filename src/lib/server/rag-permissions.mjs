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
 * Whether the browser RAG proxy must pre-authorize `library_id` against an
 * active workspace library before dispatching.
 *
 * `GET /v1/threads` lists only the authenticated principal's own archived
 * conversations (strictly scoped by organization, workspace, and principal
 * in `ConversationRepository`), and accepts sentinel filter values
 * (`__unlinked__`, `all`) as well as historical IDs of deleted libraries
 * that still own archived threads.
 *
 * @param {string} method
 * @param {string[]} pathSegments
 */
export function requiresAuthorizedLibraryPrecheck(method, pathSegments) {
	const normalizedMethod = method.toUpperCase();
	const isThreadListRead =
		(normalizedMethod === "GET" || normalizedMethod === "HEAD") &&
		pathSegments.length === 2 &&
		pathSegments[0] === "v1" &&
		pathSegments[1] === "threads";
	return !isThreadListRead;
}
