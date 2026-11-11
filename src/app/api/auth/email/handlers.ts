import { after, NextResponse } from "next/server";
import { getDatabase } from "@/db";
import { logger } from "@/lib/observability";
import {
	accountEmailBaseUrl,
	consumeAccountEmailToken,
	issueAccountEmailToken,
} from "@/lib/server/auth/email-tokens";
import { resolveClientAddress } from "@/lib/server/auth/login-rate-limit";
import {
	hydrateIdentity,
	issueSessionToken,
	SESSION_COOKIE,
	sessionCookieOptions,
} from "@/lib/server/auth/session";
import { isEmailConfigured, sendAccountEmail } from "@/lib/server/email";
import { consumeFixedWindow } from "@/lib/server/security/fixed-window-rate-limit";
import { createAccountEmailHandlers } from "@/server/http/account-email";

export const accountEmailHandlers = createAccountEmailHandlers({
	baseUrl: accountEmailBaseUrl(process.env.APP_BASE_URL),
	configured: () => isEmailConfigured(),
	defer: (work) => after(work),
	async limit(request, subject, action) {
		const ip = await consumeFixedWindow({
			namespace: `account-email-${action}-ip`,
			subject: resolveClientAddress(request),
			limit: action === "request" ? 20 : 60,
			windowSeconds: 900,
		});
		if (!ip.ok || action === "consume") return ip;
		const account = await consumeFixedWindow({
			namespace: "account-email-account",
			subject,
			limit: 3,
			windowSeconds: 900,
		});
		if (!account.ok) return account;
		return consumeFixedWindow({
			namespace: "account-email-cooldown",
			subject,
			limit: 1,
			windowSeconds: 60,
		});
	},
	async send(input) {
		const pool = getDatabase().$client;
		const token = await issueAccountEmailToken(pool, {
			...input,
			baseUrl: process.env.APP_BASE_URL ?? "",
		});
		if (!token) return;
		const delivery = await sendAccountEmail({
			to: input.email,
			url: token.url,
			purpose: input.purpose,
			idempotencyKey: `account:${token.tokenId}`,
		});
		await pool.query(
			`INSERT INTO app.audit_logs (organization_id, workspace_id, actor_id, action, resource_type, resource_id, details)
			 VALUES ($1,$2,NULL,'auth.email_delivery','account_email_token',$3,$4::jsonb)`,
			[
				token.organizationId,
				token.workspaceId,
				token.tokenId,
				JSON.stringify({
					purpose: input.purpose,
					status: delivery.sent ? "accepted" : "failed",
					code: delivery.sent ? "accepted" : delivery.reason,
					...(delivery.sent ? { provider_message_id: delivery.messageId } : {}),
				}),
			],
		);
	},
	consume: (input) => consumeAccountEmailToken(getDatabase().$client, input),
	async login(principal) {
		const identity = await hydrateIdentity(
			principal.userId,
			principal.workspaceId,
			"local",
			principal.credentialVersion,
		);
		if (!identity) return null;
		const token = await issueSessionToken(
			identity,
			principal.credentialVersion,
		);
		await getDatabase().$client.query(
			"UPDATE app.users SET last_login_at=clock_timestamp(), updated_at=clock_timestamp() WHERE id=$1 AND organization_id=$2",
			[principal.userId, principal.organizationId],
		);
		const response = new NextResponse();
		response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
		return { identity, cookie: response.headers.get("set-cookie") as string };
	},
	report: (code) => logger.error({ event: "auth.email.failed", code }),
});
