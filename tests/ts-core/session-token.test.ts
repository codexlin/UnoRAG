import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";
import {
	createSignedSessionToken,
	readSessionClaims,
	SESSION_COOKIE,
	verifySessionToken,
} from "@/lib/server/auth/session-token";
import { proxy } from "@/proxy";

const SECRET = "session-token-test-secret-at-least-32-characters";
const NOW = 1_800_000_000;

function withSecret<T>(run: () => T): T {
	const previous = process.env.UNORAG_SESSION_SECRET;
	process.env.UNORAG_SESSION_SECRET = SECRET;
	try {
		return run();
	} finally {
		if (previous == null) delete process.env.UNORAG_SESSION_SECRET;
		else process.env.UNORAG_SESSION_SECRET = previous;
	}
}

test("session token verifies valid claims and rejects tampering and expiry", () => {
	withSecret(() => {
		const token = createSignedSessionToken(
			{ principalId: "principal-1", workspaceId: "workspace-1" },
			NOW,
		);
		const claims = verifySessionToken(token, NOW + 1);
		assert.equal(claims?.principal_id, "principal-1");
		assert.equal(claims?.workspace_id, "workspace-1");
		assert.equal(claims?.provider, "local");
		assert.equal(verifySessionToken(`${token}x`, NOW + 1), null);
		assert.equal(verifySessionToken(token, NOW + 8 * 60 * 60), null);
	});
});

test("session token preserves the OIDC authentication source", () => {
	withSecret(() => {
		const token = createSignedSessionToken(
			{
				principalId: "principal-1",
				workspaceId: "workspace-1",
				provider: "oidc",
			},
			NOW,
		);
		assert.equal(verifySessionToken(token, NOW + 1)?.provider, "oidc");
	});
});

test("cookie parsing fails closed for malformed values", () => {
	withSecret(() => {
		const token = createSignedSessionToken({
			principalId: "principal-1",
			workspaceId: "workspace-1",
		});
		assert.equal(
			readSessionClaims(`${SESSION_COOKIE}=${encodeURIComponent(token)}`)
				?.workspace_id,
			"workspace-1",
		);
		assert.equal(readSessionClaims(`${SESSION_COOKIE}=%E0%A4%A`), null);
	});
});

test("proxy redirects invalid sessions and lets valid sessions reach the DAL", () => {
	withSecret(() => {
		const unauthorized = proxy(
			new NextRequest("https://unorag.test/app/libraries"),
		);
		assert.equal(unauthorized.status, 307);
		assert.equal(
			unauthorized.headers.get("location"),
			"https://unorag.test/login",
		);

		const token = createSignedSessionToken({
			principalId: "principal-1",
			workspaceId: "workspace-1",
		});
		const authorized = proxy(
			new NextRequest("https://unorag.test/app/libraries", {
				headers: { cookie: `${SESSION_COOKIE}=${token}` },
			}),
		);
		assert.equal(authorized.status, 200);
		assert.equal(authorized.headers.get("x-middleware-next"), "1");
	});
});
