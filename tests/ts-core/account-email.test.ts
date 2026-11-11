import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { Parser } from "htmlparser2";
import type { EmailDependencies } from "../../src/lib/server/email";

const require = createRequire(import.meta.url);
const nodeModule = require("node:module");
const originalResolve = nodeModule._resolveFilename;
// server-only is a framework boundary, not a runtime dependency in this harness.
nodeModule._resolveFilename = (name: string, ...args: unknown[]) =>
	name === "server-only"
		? require.resolve("next/package.json")
		: originalResolve.call(nodeModule, name, ...args);
const emailModule = import("../../src/lib/server/email").finally(() => {
	nodeModule._resolveFilename = originalResolve;
});
const templatesModule = emailModule.then(
	() => import("../../src/lib/server/email-templates"),
);

const environment = {
	EMAIL_PROVIDER: "resend",
	EMAIL_FROM: "UnoRAG <accounts@example.test>",
	RESEND_API_KEY: "re_private_test_secret",
};
const messageId = "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794";
const account = {
	to: "reader@example.test",
	url: "https://unorag.example.test/auth/verify?token=private-token&purpose=login",
	purpose: "login" as const,
	idempotencyKey: "login/event-123",
};
const invite = {
	to: account.to,
	inviteUrl: account.url,
	workspaceName: "研发知识库",
	role: "editor",
};
const success = { sent: true, provider: "resend", messageId };
const failure = (reason: string) => ({
	sent: false,
	provider: "resend",
	reason,
});

function capture(
	response: () => Response = () => Response.json({ id: messageId }),
) {
	const calls: { url: unknown; init: RequestInit | undefined }[] = [];
	const dependencies: EmailDependencies = {
		environment,
		fetch: async (url, init) => {
			calls.push({ url, init });
			return response();
		},
	};
	return { calls, dependencies };
}

function parseHtml(html: string) {
	const elements: { tag: string; attributes: Record<string, string> }[] = [];
	let text = "";
	const parser = new Parser({
		onopentag(tag, attributes) {
			elements.push({ tag, attributes });
		},
		ontext(value) {
			text += value;
		},
	});
	parser.end(html);
	return { elements, text };
}

for (const purpose of ["login", "reset"] as const) {
	test(`${purpose} sends Chinese HTML and plain text with authenticated idempotent headers`, async () => {
		const { sendAccountEmail } = await emailModule;
		const { calls, dependencies } = capture();
		assert.deepEqual(
			await sendAccountEmail({ ...account, purpose }, dependencies),
			success,
		);
		assert.equal(calls.length, 1);
		const { url, init } = calls[0];
		assert.equal(url, "https://api.resend.com/emails");
		assert.equal(init?.method, "POST");
		assert.equal(init?.redirect, "error");
		assert.equal(init?.cache, "no-store");
		assert.equal(init.signal?.aborted, false);
		const headers = new Headers(init.headers);
		assert.equal(
			headers.get("authorization"),
			`Bearer ${environment.RESEND_API_KEY}`,
		);
		assert.equal(headers.get("content-type"), "application/json");
		assert.equal(headers.get("idempotency-key"), account.idempotencyKey);
		const body = JSON.parse(String(init.body));
		assert.equal(body.from, environment.EMAIL_FROM);
		assert.deepEqual(body.to, [account.to]);
		assert.match(body.subject, purpose === "login" ? /登录/ : /重置/);
		assert.match(body.text, /UnoRAG/);
		assert.match(body.text, /只能使用一次/);
		assert.match(body.text, /15 分钟/);
		assert.match(parseHtml(body.html).text, /15 分钟/);
		assert.ok(body.text.includes(account.url));
		assert.doesNotMatch(body.text, /<\/?(?:html|table|a)\b|&amp;/);
		const parsed = parseHtml(body.html);
		assert.equal(
			parsed.elements.find((element) => element.tag === "html")?.attributes
				.lang,
			"zh-CN",
		);
		assert.ok(
			parsed.elements.some(
				(element) =>
					element.tag === "table" && element.attributes.role === "presentation",
			),
		);
		const links = parsed.elements.filter((element) => element.tag === "a");
		assert.equal(links.length, 2);
		assert.ok(links.every((link) => link.attributes.href === account.url));
		assert.match(body.html, /#0f766e/);
		assert.doesNotMatch(body.html, /<script|<img|<svg/i);
	});
}

test("invitation remains backward compatible and escapes text and URL attributes without corrupting plain text", async () => {
	const { sendInviteEmail } = await emailModule;
	const { calls, dependencies } = capture();
	const workspaceName = `<img src=x onerror="attack()"> & '研发'\r\nBcc: other@example.test`;
	const role = `owner <script>alert('x')</script>`;
	const inviteUrl = `https://example.test/invite?token="'<>&next=1`;
	assert.deepEqual(
		await sendInviteEmail(
			{ ...invite, workspaceName, role, inviteUrl },
			dependencies,
		),
		success,
	);
	const body = JSON.parse(String(calls[0].init?.body));
	assert.equal(
		new Headers(calls[0].init?.headers).has("idempotency-key"),
		false,
	);
	assert.doesNotMatch(body.subject, /[\r\n]/);
	assert.ok(body.text.includes(workspaceName));
	assert.ok(body.text.includes(role));
	assert.ok(body.text.includes(inviteUrl));
	const parsed = parseHtml(body.html);
	assert.ok(parsed.text.includes(workspaceName));
	assert.ok(parsed.text.includes(role));
	assert.ok(
		parsed.elements
			.filter((element) => element.tag === "a")
			.every((link) => link.attributes.href === inviteUrl),
	);
	assert.ok(
		parsed.elements.every(
			(element) => !["script", "img"].includes(element.tag),
		),
	);
	assert.ok(
		parsed.elements.every((element) =>
			Object.keys(element.attributes).every(
				(attribute) => !attribute.startsWith("on"),
			),
		),
	);
	assert.match(body.html, /&lt;img/);
	assert.match(body.html, /&amp;/);
	assert.match(body.html, /&quot;/);
	assert.match(body.html, /&#39;/);
});

for (const [role, label] of [
	["viewer", "查看者"],
	["editor", "编辑者"],
	["admin", "管理员"],
] as const) {
	test(`invitation explains expiry and existing account verification for ${role}`, async () => {
		const { renderInviteEmail } = await templatesModule;
		const rendered = renderInviteEmail({ ...invite, role });
		for (const text of [rendered.text, parseHtml(rendered.html).text]) {
			assert.ok(text.includes(`「${label}」`));
			assert.match(text, /7 天/);
			assert.match(text, /首次使用请设置密码/);
			assert.match(text, /已有账号请验证原密码/);
			assert.doesNotMatch(text, /接受邀请并设置密码后即可加入/);
		}
	});
}

for (const [index, url] of [
	"javascript:alert('private-token')",
	"data:text/html,private-token",
	"file:///private-token",
	"//example.test/private-token",
	"/auth/private-token",
	" https://example.test/private-token",
	"https://example.test/private-token\n",
	"https://exam\tple.test/private-token",
	"https://example.test/\u0000private-token",
	"https://example.test/\u007fprivate-token",
	"https://user:private-token@example.test/",
	"https://@example.test/private-token",
	"https://good.test\\@bad.test/private-token",
	"https:///example.test/private-token",
	"https://?private-token",
	"https://[invalid]/private-token",
].entries()) {
	test(`unsafe URL case ${index + 1} is refused without sending or leaking`, async () => {
		const { sendAccountEmail, sendInviteEmail } = await emailModule;
		const { renderAccountEmail } = await templatesModule;
		const { calls, dependencies } = capture();
		assert.throws(() => renderAccountEmail({ url, purpose: "login" }), {
			message: "invalid_action_url",
		});
		assert.deepEqual(
			await sendAccountEmail({ ...account, url }, dependencies),
			failure("invalid_email_template"),
		);
		assert.deepEqual(
			await sendInviteEmail({ ...invite, inviteUrl: url }, dependencies),
			failure("invalid_email_template"),
		);
		assert.equal(calls.length, 0);
	});
}

for (const url of [
	"http://localhost:3000/auth?token=local",
	"https://example.test/auth?token=abc%2B123&next=%2Fapp",
]) {
	test("absolute trusted HTTP(S) URLs are preserved byte-for-byte", async () => {
		const { renderAccountEmail } = await templatesModule;
		const rendered = renderAccountEmail({ url, purpose: "reset" });
		assert.ok(rendered.text.includes(url));
		assert.ok(
			parseHtml(rendered.html)
				.elements.filter((element) => element.tag === "a")
				.every((link) => link.attributes.href === url),
		);
	});
}

test("unknown purposes fail closed with a safe template error", async () => {
	const { sendAccountEmail } = await emailModule;
	const { renderAccountEmail } = await templatesModule;
	const purpose = "private-purpose" as "login";
	assert.throws(() => renderAccountEmail({ url: account.url, purpose }), {
		message: "invalid_email_purpose",
	});
	const { calls, dependencies } = capture();
	assert.deepEqual(
		await sendAccountEmail({ ...account, purpose }, dependencies),
		failure("invalid_email_template"),
	);
	assert.equal(calls.length, 0);
});

test("configuration reads only the three email settings and never sends when disabled or incomplete", async () => {
	const { isEmailConfigured, sendAccountEmail, sendInviteEmail } =
		await emailModule;
	const cases: Record<string, string>[] = [
		{},
		{ ...environment, EMAIL_PROVIDER: "none" },
		{ ...environment, EMAIL_PROVIDER: "smtp" },
		{ ...environment, EMAIL_FROM: " " },
		{ ...environment, RESEND_API_KEY: " " },
	];
	for (const env of cases) {
		const { calls, dependencies } = capture();
		dependencies.environment = env;
		assert.equal(isEmailConfigured(env), false);
		for (const result of [
			await sendAccountEmail(account, dependencies),
			await sendInviteEmail(invite, dependencies),
		]) {
			assert.equal(result.sent, false);
			assert.equal(
				result.provider,
				env.EMAIL_PROVIDER === "resend" ? "resend" : "none",
			);
		}
		assert.equal(calls.length, 0);
	}
	const accessed: string[] = [];
	const guardedEnv = new Proxy(environment, {
		get(target, key: keyof typeof environment) {
			accessed.push(key);
			assert.ok(
				["EMAIL_PROVIDER", "EMAIL_FROM", "RESEND_API_KEY"].includes(key),
			);
			return target[key];
		},
	});
	assert.equal(isEmailConfigured(guardedEnv), true);
	assert.equal(accessed.length, 3);
	assert.equal(
		isEmailConfigured({
			EMAIL_PROVIDER: " ReSend ",
			EMAIL_FROM: " from@example.test ",
			RESEND_API_KEY: " re_key ",
		}),
		true,
	);
});

test("default environment and fetch work without injected dependencies", async (context) => {
	const { sendAccountEmail, isEmailConfigured } = await emailModule;
	for (const [key, value] of Object.entries(environment)) {
		const previous = process.env[key];
		process.env[key] = value;
		context.after(() => {
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		});
	}
	const fetchMock = context.mock.method(globalThis, "fetch", async () =>
		Response.json({ id: messageId }),
	);
	assert.equal(isEmailConfigured(), true);
	assert.deepEqual(await sendAccountEmail(account), success);
	assert.equal(fetchMock.mock.callCount(), 1);
});

for (const key of [
	"",
	" ",
	"x\n",
	"x\r\nInjected: secret",
	"中文",
	"x".repeat(257),
]) {
	test("invalid idempotency keys fail before transport", async () => {
		const { sendAccountEmail } = await emailModule;
		const { calls, dependencies } = capture();
		assert.deepEqual(
			await sendAccountEmail({ ...account, idempotencyKey: key }, dependencies),
			failure("invalid_idempotency_key"),
		);
		assert.equal(calls.length, 0);
	});
}

test("idempotency uses the supplied event key, never the URL, and stable invite IDs", async () => {
	const { sendAccountEmail, sendInviteEmail } = await emailModule;
	const { calls, dependencies } = capture();
	const key = "a".repeat(256);
	await sendAccountEmail({ ...account, idempotencyKey: key }, dependencies);
	await sendAccountEmail({ ...account, idempotencyKey: key }, dependencies);
	await sendInviteEmail({ ...invite, inviteId: "invite-123" }, dependencies);
	await sendInviteEmail({ ...invite, inviteId: "invite-123" }, dependencies);
	assert.deepEqual(
		calls.map((call) => new Headers(call.init?.headers).get("idempotency-key")),
		[key, key, "invite/invite-123", "invite/invite-123"],
	);
	assert.equal(calls[0].init?.body, calls[1].init?.body);
	assert.equal(calls[2].init?.body, calls[3].init?.body);
	assert.deepEqual(
		await sendInviteEmail({ ...invite, inviteId: "" }, dependencies),
		failure("invalid_idempotency_key"),
	);
	assert.deepEqual(
		await sendAccountEmail(
			{ ...account, idempotencyKey: undefined as unknown as string },
			dependencies,
		),
		failure("invalid_idempotency_key"),
	);
	assert.equal(calls.length, 4);
});

test("recipient header injection cannot reach the provider", async () => {
	const { sendAccountEmail } = await emailModule;
	const { calls, dependencies } = capture();
	for (const to of [
		"reader@example.test\r\nBcc: secret@example.test",
		"reader@example.test\n",
	]) {
		assert.deepEqual(
			await sendAccountEmail({ ...account, to }, dependencies),
			failure("invalid_recipient"),
		);
	}
	assert.equal(calls.length, 0);
});

for (const status of [301, 400, 401, 403, 409, 422, 429, 500, 503]) {
	test(`HTTP ${status} is a safe status code without reading a body or retrying`, async (context) => {
		const { sendAccountEmail } = await emailModule;
		const response = new Response("private-token re_private_test_secret", {
			status,
		});
		const text = context.mock.method(response, "text", () =>
			assert.fail("must not read an error body"),
		);
		const json = context.mock.method(response, "json", () =>
			assert.fail("must not read an error body"),
		);
		assert.ok(response.body);
		const reader = context.mock.method(response.body, "getReader", () =>
			assert.fail("must not stream an error body"),
		);
		const { calls, dependencies } = capture(() => response);
		assert.deepEqual(
			await sendAccountEmail(account, dependencies),
			failure(`resend_http_${status}`),
		);
		assert.equal(calls.length, 1);
		assert.equal(text.mock.callCount(), 0);
		assert.equal(json.mock.callCount(), 0);
		assert.equal(reader.mock.callCount(), 0);
	});
}

for (const payload of [
	null,
	[],
	{},
	{ data: { id: messageId } },
	{ id: 123 },
	{ id: "" },
	{ id: "private-token" },
	{ id: account.url },
	{ id: `${messageId}\n` },
	{ id: `prefix${messageId}` },
	{ id: messageId.replace(/-/g, "") },
]) {
	test("Resend success requires an exact top-level UUID id", async () => {
		const { sendAccountEmail } = await emailModule;
		const { calls, dependencies } = capture(() => Response.json(payload));
		assert.deepEqual(
			await sendAccountEmail(account, dependencies),
			failure("resend_invalid_response"),
		);
		assert.equal(calls.length, 1);
	});
}

test("malformed success bodies and transport exceptions stay private and are not logged", async (context) => {
	const { sendAccountEmail } = await emailModule;
	const logs = ["log", "warn", "error", "info", "debug"].map((method) =>
		context.mock.method(console, method as "log", () => {}),
	);
	const { dependencies, calls } = capture(
		() =>
			new Response(
				`private-token ${environment.RESEND_API_KEY} ${account.url}`,
			),
	);
	assert.deepEqual(
		await sendAccountEmail(account, dependencies),
		failure("resend_invalid_response"),
	);
	assert.equal(calls.length, 1);
	for (const error of [
		new Error(`${environment.RESEND_API_KEY} ${account.url}`),
		account.url,
	]) {
		let attempts = 0;
		assert.deepEqual(
			await sendAccountEmail(account, {
				environment,
				fetch: async () => {
					attempts++;
					throw error;
				},
			}),
			failure("resend_fetch_failed"),
		);
		assert.equal(attempts, 1);
	}
	assert.ok(logs.every((log) => log.mock.callCount() === 0));
});

for (const stage of ["request", "body", "delayed-body"] as const) {
	test(`five-second total deadline bounds ${stage} even if abort is ignored`, async (context) => {
		const { sendAccountEmail } = await emailModule;
		context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
		let attempts = 0;
		let signal: AbortSignal | null | undefined;
		let resolveRequest: ((response: Response) => void) | undefined;
		const response = new Response(new ReadableStream<Uint8Array>());
		assert.ok(response.body);
		const reader = response.body.getReader();
		context.mock.method(reader, "read", () => new Promise(() => {}));
		context.mock.method(reader, "cancel", () => new Promise<void>(() => {}));
		const body = context.mock.method(response.body, "getReader", () => reader);
		const pending = sendAccountEmail(account, {
			environment,
			fetch: (_url, init) => {
				attempts++;
				signal = init?.signal;
				if (stage === "body") return Promise.resolve(response);
				return new Promise<Response>((resolve) => {
					resolveRequest = resolve;
				});
			},
		});
		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		await setImmediate();
		if (stage === "delayed-body") {
			context.mock.timers.tick(4_000);
			resolveRequest?.(response);
			await setImmediate();
		}
		context.mock.timers.tick(stage === "delayed-body" ? 999 : 4_999);
		await setImmediate();
		assert.equal(settled, false);
		assert.equal(signal?.aborted, false);
		context.mock.timers.tick(1);
		await setImmediate();
		assert.equal(settled, true);
		assert.deepEqual(await pending, failure("resend_timeout"));
		assert.equal(signal?.aborted, true);
		assert.equal(attempts, 1);
		if (stage === "request") {
			resolveRequest?.(response);
			await setImmediate();
			assert.equal(body.mock.callCount(), 0);
		} else assert.equal(body.mock.callCount(), 1);
		context.mock.timers.tick(20_000);
		assert.equal(attempts, 1);
	});
}

test("deadline cancels real stalled response streams", async (context) => {
	const { sendAccountEmail } = await emailModule;
	context.mock.timers.enable({ apis: ["setTimeout"] });
	let cancelled = false;
	const response = new Response(
		new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		}),
	);
	const { dependencies, calls } = capture(() => response);
	const pending = sendAccountEmail(account, dependencies);
	await setImmediate();
	context.mock.timers.tick(5_000);
	await setImmediate();
	assert.deepEqual(await pending, failure("resend_timeout"));
	assert.equal(calls.length, 1);
	assert.equal(cancelled, true);
	assert.equal(response.body?.locked, false);
	await setImmediate();
});

for (const size of [16 * 1024, 16 * 1024 + 1]) {
	for (const chunkSize of [1_024, 20 * 1024]) {
		test(`success response limit checks ${size} bytes in ${chunkSize}-byte chunks`, async (context) => {
			const { sendAccountEmail } = await emailModule;
			const json = JSON.stringify({ id: messageId, note: "响应" });
			const encoder = new TextEncoder();
			const bytes = encoder.encode(
				json + " ".repeat(size - encoder.encode(json).byteLength),
			);
			let offset = 0;
			let cancelled = false;
			const response = new Response(
				new ReadableStream<Uint8Array>(
					{
						pull(controller) {
							if (offset === bytes.byteLength) controller.close();
							else {
								controller.enqueue(bytes.subarray(offset, offset + chunkSize));
								offset = Math.min(offset + chunkSize, bytes.byteLength);
							}
						},
						cancel() {
							cancelled = true;
						},
					},
					{ highWaterMark: 0 },
				),
				{
					headers: { "Content-Length": "1" },
				},
			);
			context.mock.method(response, "json", () =>
				assert.fail("must read with a bounded stream"),
			);
			const { calls, dependencies } = capture(() => response);
			assert.deepEqual(
				await sendAccountEmail(account, dependencies),
				size === 16 * 1024 ? success : failure("resend_invalid_response"),
			);
			assert.equal(calls.length, 1);
			assert.equal(cancelled, size > 16 * 1024);
			assert.equal(response.body?.locked, false);
		});
	}
}

test("bounded reader decodes split UTF-8 and waits for the complete body", async (context) => {
	const { sendAccountEmail } = await emailModule;
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const bytes = new TextEncoder().encode(
		JSON.stringify({ id: messageId, note: "中文" }),
	);
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	const response = new Response(
		new ReadableStream<Uint8Array>({
			start(stream) {
				controller = stream;
			},
		}),
	);
	const { dependencies } = capture(() => response);
	const pending = sendAccountEmail(account, dependencies);
	let settled = false;
	void pending.then(() => {
		settled = true;
	});
	for (const byte of bytes) controller?.enqueue(new Uint8Array([byte]));
	await setImmediate();
	assert.equal(settled, false);
	context.mock.timers.tick(4_999);
	controller?.close();
	await setImmediate();
	assert.deepEqual(await pending, success);
	context.mock.timers.tick(1);
	assert.equal(response.body?.locked, false);
});

test("missing, invalid UTF-8, and failing success streams produce only safe errors", async () => {
	const { sendAccountEmail } = await emailModule;
	for (const response of [
		new Response(),
		new Response(new Uint8Array([0xff])),
		new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.error(new Error("private body failure"));
				},
			}),
		),
	]) {
		const { calls, dependencies } = capture(() => response);
		assert.deepEqual(
			await sendAccountEmail(account, dependencies),
			failure("resend_invalid_response"),
		);
		assert.equal(calls.length, 1);
	}
});

test("body cancellation cannot leak cleanup failures or stall HTTP errors", async (context) => {
	const { sendAccountEmail } = await emailModule;
	for (const cleanup of ["throws", "rejects", "stalls"] as const) {
		const response = new Response("private provider body", { status: 503 });
		assert.ok(response.body);
		context.mock.method(response.body, "cancel", () => {
			if (cleanup === "throws") throw new Error("private cleanup");
			return cleanup === "rejects"
				? Promise.reject(new Error("private cleanup"))
				: new Promise<void>(() => {});
		});
		const { dependencies } = capture(() => response);
		assert.deepEqual(
			await sendAccountEmail(account, dependencies),
			failure("resend_http_503"),
		);
	}
	await setImmediate();
});

test("completed requests clear their deadline timer", async (context) => {
	const { sendAccountEmail } = await emailModule;
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const { dependencies, calls } = capture();
	assert.deepEqual(await sendAccountEmail(account, dependencies), success);
	context.mock.timers.tick(10_000);
	assert.equal(calls[0].init?.signal?.aborted, false);
});
