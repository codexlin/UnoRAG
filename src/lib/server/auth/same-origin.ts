import { resolveMutationBaseUrl } from "./email-tokens";

export function isSameOriginSessionRequest(request: Request): boolean {
	if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;

	const site = request.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin") return false;

	const origin = request.headers.get("origin");
	// Non-browser clients can send a session cookie without browser headers.
	if (origin === null) return true;
	try {
		if (origin === new URL(request.url).origin) return true;
		const baseUrl = resolveMutationBaseUrl();
		return !!baseUrl && origin === new URL(baseUrl).origin;
	} catch {
		return false;
	}
}
