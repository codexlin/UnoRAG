import assert from "node:assert/strict";
import test from "node:test";

import {
	isLocalLoginEnabled,
	isOidcEnabled,
	readOidcSettings,
	resolveApplicationOrigin,
} from "@/lib/server/auth/config";
import {
	createOidcFlowToken,
	readOidcFlowToken,
	safeReturnTo,
} from "@/lib/server/auth/oidc-flow";

const SECRET = "oidc-flow-test-secret-at-least-32-characters";
const NOW = 1_800_000_000;

function withSessionSecret<T>(run: () => T): T {
	const previous = process.env.UNORAG_SESSION_SECRET;
	process.env.UNORAG_SESSION_SECRET = SECRET;
	try {
		return run();
	} finally {
		if (previous == null) delete process.env.UNORAG_SESSION_SECRET;
		else process.env.UNORAG_SESSION_SECRET = previous;
	}
}

test("OIDC flow token binds short-lived PKCE state and rejects tampering", () => {
	withSessionSecret(() => {
		const token = createOidcFlowToken(
			{
				state: "state-1",
				nonce: "nonce-1",
				codeVerifier: "verifier-1",
				redirectUri: "https://kb.example.com/api/auth/oidc/callback",
				returnTo: "/app/libraries?view=active",
			},
			NOW,
		);
		const flow = readOidcFlowToken(token, NOW + 1);
		assert.equal(flow?.state, "state-1");
		assert.equal(flow?.returnTo, "/app/libraries?view=active");
		assert.equal(readOidcFlowToken(`${token}x`, NOW + 1), null);
		assert.equal(readOidcFlowToken(token, NOW + 10 * 60), null);
	});
});

test("OIDC return destinations stay on the UnoRAG origin", () => {
	assert.equal(safeReturnTo("/app/ask?thread=1"), "/app/ask?thread=1");
	assert.equal(safeReturnTo("https://evil.example/path"), "/app");
	assert.equal(safeReturnTo("//evil.example/path"), "/app");
	assert.equal(safeReturnTo("/\\evil.example/path"), "/app");
});

test("OIDC configuration is explicit and local login defaults to break-glass", () => {
	const env = {
		NODE_ENV: "production",
		OIDC_ENABLED: "true",
		OIDC_ISSUER_URL: "https://id.example.com/realms/acme",
		OIDC_CLIENT_ID: "unorag",
		OIDC_CLIENT_SECRET: "secret",
		UNORAG_ORGANIZATION_ID: "00000000-0000-4000-8000-000000000001",
		OIDC_SCOPES: "profile email",
	} satisfies NodeJS.ProcessEnv;
	assert.equal(isOidcEnabled(env), true);
	assert.equal(isLocalLoginEnabled(env), true);
	assert.equal(readOidcSettings(env).scopes, "openid profile email");
	assert.equal(
		resolveApplicationOrigin("http://internal:3000/path", {
			...env,
			APP_BASE_URL: "https://kb.example.com/base",
		}),
		"https://kb.example.com",
	);
	assert.throws(
		() => resolveApplicationOrigin("https://kb.example.com", env),
		/APP_BASE_URL is required/,
	);
	assert.throws(
		() =>
			readOidcSettings({
				...env,
				OIDC_ISSUER_URL: "http://id.example.com",
			}),
		/OIDC_ISSUER_URL must use HTTPS/,
	);
});
