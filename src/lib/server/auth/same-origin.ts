import { resolveMutationBaseUrl } from "./email-tokens";

function originForHost(host: string, protocol: string): string | null {
	if (!/^(?:[a-z0-9.-]+|\[[a-f0-9:.]+\])(?::\d+)?$/i.test(host)) {
		return null;
	}
	return new URL(`${protocol}://${host}`).origin;
}

function configuredPublicOrigin(baseUrl: string | undefined): string | null {
	if (!baseUrl) return null;
	try {
		const url = new URL(baseUrl);
		return url.protocol === "http:" || url.protocol === "https:"
			? url.origin
			: null;
	} catch {
		return null;
	}
}

export function isSameOriginSessionRequest(
	request: Request,
	appBaseUrl?: string,
): boolean {
	if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;

	const site = request.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin") return false;

	const origin = request.headers.get("origin");
	// Non-browser clients can send a session cookie without browser headers.
	if (origin === null) return true;
	try {
		const url = new URL(request.url);
		const protocol =
			request.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1);
		if (protocol !== "http" && protocol !== "https") return false;
		const configuredOrigin = configuredPublicOrigin(
			appBaseUrl ?? resolveMutationBaseUrl(),
		);
		const host = request.headers.get("host");
		if (host === null) {
			return origin === (configuredOrigin ?? url.origin);
		}

		// Next may build request.url from the listener's hostname and port.
		const directOrigin = originForHost(host, protocol);
		if (directOrigin === null) return false;
		const forwardedHost = request.headers.get("x-forwarded-host");
		// A proxy may rewrite Host. Accept its public host only when the
		// deployment has independently configured that exact origin.
		if (
			configuredOrigin &&
			forwardedHost &&
			originForHost(forwardedHost, protocol) === configuredOrigin
		) {
			return origin === configuredOrigin;
		}
		return origin === directOrigin;
	} catch {
		return false;
	}
}
