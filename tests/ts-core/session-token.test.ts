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
		assert.equal(verifySessionToken(`${token}x`, NOW + 1), null);
		assert.equal(verifySessionToken(token, NOW + 8 * 60 * 60), null);
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

test("proxy keeps bootstrap sessions inside the password change flow", () => {
	withSecret(() => {
		const token = createSignedSessionToken({
			principalId: "principal-1",
			workspaceId: "workspace-1",
			mustChangePassword: true,
		});
		const claims = verifySessionToken(token);
		assert.equal(claims?.must_change_password, true);

		const appResponse = proxy(
			new NextRequest("https://unorag.test/app", {
				headers: { cookie: `${SESSION_COOKIE}=${token}` },
			}),
		);
		assert.equal(appResponse.status, 307);
		assert.equal(
			appResponse.headers.get("location"),
			"https://unorag.test/change-password",
		);

		const passwordResponse = proxy(
			new NextRequest("https://unorag.test/change-password", {
				headers: { cookie: `${SESSION_COOKIE}=${token}` },
			}),
		);
		assert.equal(passwordResponse.status, 200);
	});
});

test("password setup reaches the DAL so server-side resets cannot redirect-loop", () => {
	withSecret(() => {
		const token = createSignedSessionToken({
			principalId: "principal-1",
			workspaceId: "workspace-1",
		});
		const response = proxy(
			new NextRequest("https://unorag.test/change-password", {
				headers: { cookie: `${SESSION_COOKIE}=${token}` },
			}),
		);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("x-middleware-next"), "1");
	});
});
