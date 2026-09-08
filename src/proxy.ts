import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
	SESSION_COOKIE,
	verifySessionToken,
} from "@/lib/server/auth/session-token";

export function proxy(request: NextRequest) {
	const token = request.cookies.get(SESSION_COOKIE)?.value;
	const claims = token ? verifySessionToken(token) : null;
	if (claims) {
		const changingPassword = request.nextUrl.pathname === "/change-password";
		if (claims.must_change_password && !changingPassword) {
			return NextResponse.redirect(new URL("/change-password", request.url));
		}
		return NextResponse.next();
	}

	return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
	matcher: ["/app/:path*", "/change-password"],
};
