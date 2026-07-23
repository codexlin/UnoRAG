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
