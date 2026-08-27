import { type NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import {
	isOidcEnabled,
	resolveApplicationOrigin,
} from "@/lib/server/auth/config";
import {
	createOidcFlowToken,
	OIDC_FLOW_COOKIE,
	oidcFlowCookieOptions,
	safeReturnTo,
} from "@/lib/server/auth/oidc-flow";
import {
	oidcIdentityProvider,
	oidcProtocol,
} from "@/lib/server/auth/oidc-provider";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
	if (!isOidcEnabled()) {
		return NextResponse.json(
			{ detail: "OIDC is not enabled" },
			{ status: 404 },
		);
	}

	try {
		const origin = resolveApplicationOrigin(request.url);
		const redirectUri = `${origin}/api/auth/oidc/callback`;
		const state = oidcProtocol.randomState();
		const nonce = oidcProtocol.randomNonce();
		const codeVerifier = oidcProtocol.randomPKCECodeVerifier();
		const codeChallenge =
			await oidcProtocol.calculatePKCECodeChallenge(codeVerifier);
		const authorizationUrl = await oidcIdentityProvider.authorizationUrl({
			state,
			nonce,
			codeChallenge,
			redirectUri,
		});
		const response = NextResponse.redirect(authorizationUrl);
		response.headers.set("cache-control", "no-store");
		response.cookies.set(
			OIDC_FLOW_COOKIE,
			createOidcFlowToken({
				state,
				nonce,
				codeVerifier,
				redirectUri,
				returnTo: safeReturnTo(request.nextUrl.searchParams.get("return_to")),
			}),
			oidcFlowCookieOptions(),
		);
		return response;
	} catch (error) {
		logger.error({
			event: "auth.oidc.start_failed",
			component: "auth",
			provider: "oidc",
			error,
		});
		return NextResponse.redirect(
			new URL("/login?error=oidc_unavailable", request.url),
		);
	}
}
