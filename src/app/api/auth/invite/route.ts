import { NextResponse } from "next/server";
import { z } from "zod";

import { getDatabase } from "@/db";
import { logger } from "@/lib/observability";
import {
	issueSessionToken,
	SESSION_COOKIE,
	sessionCookieOptions,
} from "@/lib/server/auth/session";
import {
	acceptInvite,
	inviteTokenSchema,
	limitInviteRequest,
	previewInvite,
	readInviteJson,
} from "@/lib/server/invites";

const acceptSchema = z.strictObject({
	token: inviteTokenSchema,
	password: z.string().min(1).max(4096),
	display_name: z.string().max(256).optional(),
});
const privateHeaders = {
	"Cache-Control": "private, no-store",
	"Referrer-Policy": "no-referrer",
};

export async function GET(request: Request) {
	const token = new URL(request.url).searchParams.get("token")?.trim() ?? "";
	if (!inviteTokenSchema.safeParse(token).success) {
		return NextResponse.json({ detail: "token is required" }, { status: 400 });
	}
	const limited = await limitInviteRequest(request, "preview");
	if (limited) return limited;
	const preview = await previewInvite(token);
	if (!preview) {
		return NextResponse.json({ detail: "invite not found" }, { status: 404 });
	}
	return NextResponse.json(preview, { headers: privateHeaders });
}

export async function POST(request: Request) {
	const body = await readInviteJson(request);
	if (body instanceof Response) return body;
	const parsed = acceptSchema.safeParse(body);
	if (!parsed.success)
		return NextResponse.json(
			{ detail: "invalid invite parameters" },
			{ status: 400 },
		);
	const limited = await limitInviteRequest(
		request,
		"accept",
		parsed.data.token,
	);
	if (limited) return limited;
	const result = await acceptInvite({
		rawToken: parsed.data.token,
		password: parsed.data.password,
		displayName: parsed.data.display_name,
	});
	if (!result.ok) {
		return NextResponse.json(
			{ detail: result.detail },
			{ status: result.status },
		);
	}
	let token: string;
	try {
		token = await issueSessionToken(result.identity, result.credentialVersion);
		// Keep user writes outside the invite's credential-locking transaction.
		await getDatabase().$client.query(
			"UPDATE app.users SET last_login_at=clock_timestamp(), updated_at=clock_timestamp() WHERE id=$1 AND organization_id=$2",
			[result.identity.principalId, result.identity.tenantId],
		);
	} catch {
		logger.error({
			event: "auth.invite.session_issue_failed",
			component: "auth",
		});
		return NextResponse.json(
			{ ...result.identity, session_created: false },
			{ status: 201, headers: privateHeaders },
		);
	}
	const response = NextResponse.json(
		{
			...result.identity,
			session_created: true,
		},
		{ headers: privateHeaders },
	);
	response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
	return response;
}
