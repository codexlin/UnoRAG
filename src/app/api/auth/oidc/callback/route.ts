import { type NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import {
	isOidcEnabled,
	resolveApplicationOrigin,
} from "@/lib/server/auth/config";
import {
	OIDC_FLOW_COOKIE,
	oidcFlowCookieOptions,
	readOidcFlowToken,
} from "@/lib/server/auth/oidc-flow";
import { oidcIdentityProvider } from "@/lib/server/auth/oidc-provider";
import {
	createSessionToken,
	SESSION_COOKIE,
	sessionCookieOptions,
} from "@/lib/server/auth/session";

export const dynamic = "force-dynamic";

function clearFlowCookie(response: NextResponse): NextResponse {
	response.cookies.set(OIDC_FLOW_COOKIE, "", {
		...oidcFlowCookieOptions(),
		maxAge: 0,
	});
	return response;
}

function loginError(request: NextRequest, code: string): NextResponse {
	return clearFlowCookie(
		NextResponse.redirect(new URL(`/login?error=${code}`, request.url)),
	);
}

export async function GET(request: NextRequest) {
	if (!isOidcEnabled()) return loginError(request, "oidc_disabled");
	const flow = readOidcFlowToken(request.cookies.get(OIDC_FLOW_COOKIE)?.value);
	if (!flow) return loginError(request, "oidc_state_invalid");

	try {
		const expectedRedirectUri = `${resolveApplicationOrigin(
			request.url,
		)}/api/auth/oidc/callback`;
		if (flow.redirectUri !== expectedRedirectUri) {
			return loginError(request, "oidc_state_invalid");
		}
		const currentUrl = new URL(flow.redirectUri);
		currentUrl.search = request.nextUrl.search;
		const identity = await oidcIdentityProvider.authenticate({
			currentUrl,
			redirectUri: flow.redirectUri,
			codeVerifier: flow.codeVerifier,
			expectedState: flow.state,
			expectedNonce: flow.nonce,
		});
		if (!identity) return loginError(request, "oidc_access_denied");

		const response = clearFlowCookie(
			NextResponse.redirect(new URL(flow.returnTo, expectedRedirectUri)),
		);
		response.cookies.set(
			SESSION_COOKIE,
			createSessionToken(identity),
			sessionCookieOptions(),
		);
		return response;
	} catch (error) {
		logger.warn({
			event: "auth.oidc.callback_failed",
			component: "auth",
			provider: "oidc",
			error,
		});
		return loginError(request, "oidc_callback_failed");
	}
}
