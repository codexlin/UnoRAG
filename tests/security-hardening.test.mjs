import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("global Next response headers enforce the self-hosted browser boundary", async () => {
	const config = await source("next.config.ts");
	for (const expected of [
		"Content-Security-Policy",
		"Strict-Transport-Security",
		"Referrer-Policy",
		"X-Content-Type-Options",
		"X-Frame-Options",
		"Permissions-Policy",
		"frame-ancestors 'none'",
		"object-src 'none'",
	]) {
		assert.match(config, new RegExp(expected.replaceAll("'", "\\'")));
	}
	assert.match(config, /poweredByHeader:\s*false/);
	assert.match(config, /source:\s*"\/api\/auth\/:path\*"/);
	assert.match(config, /Cache-Control.*no-store/);
});

test("auth routes issue registered sessions and revoke logout server-side", async () => {
	const [route, session, workspace, password, provider] = await Promise.all([
		source("src/app/api/auth/session/route.ts"),
		source("src/lib/server/auth/session.ts"),
		source("src/app/api/auth/session/workspace/route.ts"),
		source("src/app/api/auth/password/route.ts"),
		source("src/components/app/session-provider.tsx"),
	]);
	assert.match(route, /consumeLoginRateLimit/);
	assert.match(route, /issueSessionToken/);
	assert.match(route, /revokeSessionCookieHeader/);
	assert.match(session, /isSessionActive/);
	assert.match(session, /credential_version/);
	assert.match(workspace, /rotateSessionToken/);
	assert.match(password, /replacePrincipalSessionToken/);
	assert.match(provider, /if \(!response\.ok\)/);
});
