import assert from "node:assert/strict";
import test from "node:test";
import { createAccountEmailHandlers } from "../../src/server/http/account-email";

const token = "a".repeat(43);
function fixture(
	options: { configured?: boolean; limited?: boolean; failure?: boolean } = {},
) {
	const calls: string[] = [];
	const background: Array<() => Promise<void>> = [];
	const handlers = createAccountEmailHandlers({
		baseUrl: "https://unorag.example",
		configured: () => options.configured !== false,
		limit: async () =>
			options.limited
				? { ok: false, retryAfterSeconds: 60 }
				: { ok: true, remaining: 2 },
		defer: (work) => {
			background.push(work);
		},
		send: async (input) => {
			calls.push(`send:${input.email}:${input.purpose}`);
			if (options.failure) throw new Error("secret link");
		},
		consume: async (input) => {
			calls.push(`consume:${input.purpose}`);
			if (options.failure) return null;
			return {
				organizationId: "org",
				workspaceId: "ws",
				userId: "user",
				credentialVersion: "1",
			};
		},
		login: async () => ({
			identity: {
				tenantId: "org",
				workspaceId: "ws",
				principalId: "user",
				provider: "local",
				groupIds: [],
				role: "viewer",
				displayName: "User",
				email: "u@example.test",
				organizationRole: "member",
				workspaceName: "Main",
				mustChangePassword: false,
			},
			cookie: "session=opaque; HttpOnly; SameSite=Lax; Secure",
		}),
		report: (code) => {
			calls.push(`error:${code}`);
		},
	});
	return { handlers, calls, background };
}
function request(input: unknown, headers?: HeadersInit) {
	return new Request("https://unorag.example/api/auth/email/request", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(input),
	});
}

test("account mail returns a generic acceptance before account lookup/send", async () => {
	const f = fixture();
	const response = await f.handlers.request(
		request({ email: " Person@Example.test ", purpose: "login" }),
	);
	assert.equal(response.status, 202);
	assert.deepEqual(f.calls, []);
	assert.equal(f.background.length, 1);
	assert.match(response.headers.get("cache-control") ?? "", /no-store/);
	assert.doesNotMatch(await response.text(), /token|Person|http/);
	await f.background[0]();
	assert.deepEqual(f.calls, ["send:person@example.test:login"]);
});

test("account mail is fail-closed on transport, rate limits, JSON and CSRF", async () => {
	const payload = { email: "u@example.test", purpose: "reset" };
	for (const [f, expected] of [
		[fixture({ configured: false }), 503],
		[fixture({ limited: true }), 429],
	] as const) {
		const result = await f.handlers.request(request(payload));
		assert.equal(result.status, expected);
		assert.equal(f.background.length, 0);
		if (expected === 429) assert.equal(result.headers.get("retry-after"), "60");
	}
	const f = fixture();
	assert.equal(
		(
			await f.handlers.request(
				request(payload, { origin: "https://evil.test" }),
			)
		).status,
		403,
	);
	assert.equal(
		(
			await f.handlers.request(
				request(payload, { "sec-fetch-site": "cross-site" }),
			)
		).status,
		403,
	);
	assert.equal(
		(
			await f.handlers.request(
				request(payload, { "content-type": "text/plain" }),
			)
		).status,
		415,
	);
	assert.equal(
		(
			await f.handlers.request(
				request({ ...payload, redirect: "https://evil.test" }),
			)
		).status,
		400,
	);
	assert.equal(
		(await f.handlers.request(request({ ...payload, email: "a".repeat(5000) })))
			.status,
		413,
	);
	assert.deepEqual(f.calls, []);
});

test("background failures never leak provider details or change the acceptance result", async () => {
	const f = fixture({ failure: true });
	const result = await f.handlers.request(
		request({ email: "u@example.test", purpose: "reset" }),
	);
	await f.background[0]();
	assert.equal(result.status, 202);
	assert.equal(f.calls.at(-1), "error:account_email_send_failed");
	assert.doesNotMatch(await result.text(), /secret/);
});

test("only an explicit validated consume can establish a session", async () => {
	const f = fixture();
	const response = await f.handlers.consume(
		request({ purpose: "login", token }),
	);
	assert.equal(response.status, 200);
	assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly/);
	assert.deepEqual(f.calls, ["consume:login"]);
	assert.equal(
		(
			await fixture({ failure: true }).handlers.consume(
				request({ purpose: "login", token }),
			)
		).status,
		400,
	);
	assert.equal(
		(
			await f.handlers.consume(
				request({ purpose: "login", token, password: "Abcdefg" }),
			)
		).status,
		400,
	);
});

test("password reset enforces policy and never signs a session", async () => {
	const f = fixture();
	assert.equal(
		(
			await f.handlers.consume(
				request({ purpose: "reset", token, password: "abcdefg" }),
			)
		).status,
		400,
	);
	assert.deepEqual(f.calls, []);
	const result = await f.handlers.consume(
		request({ purpose: "reset", token, password: "Abcdefg" }),
	);
	assert.equal(result.status, 200);
	assert.equal(result.headers.get("set-cookie"), null);
	assert.deepEqual(await result.json(), { ok: true });
});
