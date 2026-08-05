import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
	SESSION_COOKIE,
	verifySessionToken,
} from "@/lib/server/auth/session-token";

export function proxy(request: NextRequest) {
	const token = request.cookies.get(SESSION_COOKIE)?.value;
	if (token && verifySessionToken(token)) {
		return NextResponse.next();
	}

	return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
	matcher: ["/app/:path*"],
};
