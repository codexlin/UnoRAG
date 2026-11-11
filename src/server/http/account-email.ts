import { z } from "zod";
import type {
	AccountEmailPrincipal,
	AccountEmailPurpose,
} from "../../lib/server/auth/email-tokens";
import { validatePassword } from "../../lib/server/auth/passwords.mjs";
import type { AuthIdentity } from "../../lib/server/auth/provider";
import type { RateLimitResult } from "../../lib/server/security/fixed-window-rate-limit";

const purpose = z.enum(["login", "reset"]);
const requestSchema = z.strictObject({
	email: z.string().trim().toLowerCase().max(320).email(),
	purpose,
});
const consumeSchema = z.discriminatedUnion("purpose", [
	z.strictObject({
		purpose: z.literal("login"),
		token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
	}),
	z.strictObject({
		purpose: z.literal("reset"),
		token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
		password: z.string().min(7).max(256),
	}),
]);

type Dependencies = {
	baseUrl: string | null;
	configured(): boolean;
	limit(
		request: Request,
		subject: string,
		action: "request" | "consume",
	): Promise<RateLimitResult>;
	defer(work: () => Promise<void>): void;
	send(input: { email: string; purpose: AccountEmailPurpose }): Promise<void>;
	consume(input: {
		token: string;
		purpose: AccountEmailPurpose;
		password?: string;
	}): Promise<AccountEmailPrincipal | null>;
	login(
		principal: AccountEmailPrincipal,
	): Promise<{ identity: AuthIdentity; cookie: string } | null>;
	report(code: string): void;
};

function json(body: unknown, status = 200, headers?: HeadersInit) {
	const result = new Headers(headers);
	result.set("cache-control", "private, no-store");
	result.set("referrer-policy", "no-referrer");
	return Response.json(body, { status, headers: result });
}

async function body(request: Request): Promise<unknown> {
	const reader = request.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > 4096) {
				await reader.cancel();
				return json({ detail: "请求内容过大" }, 413);
			}
			chunks.push(value);
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} finally {
		reader.releaseLock();
	}
}

export function createAccountEmailHandlers(deps: Dependencies) {
	async function handle(action: "request" | "consume", request: Request) {
		if (request.headers.get("sec-fetch-site") === "cross-site")
			return json({ detail: "forbidden" }, 403);
		const origin = request.headers.get("origin");
		if (origin && origin !== (deps.baseUrl ?? new URL(request.url).origin))
			return json({ detail: "forbidden" }, 403);
		if (
			!/^application\/json(?:\s*;|$)/i.test(
				request.headers.get("content-type") ?? "",
			)
		)
			return json({ detail: "application/json required" }, 415);
		let input: unknown;
		try {
			input = await body(request);
		} catch {
			return json({ detail: "invalid JSON body" }, 400);
		}
		if (input instanceof Response) return input;
		const parsed = (
			action === "request" ? requestSchema : consumeSchema
		).safeParse(input);
		if (!parsed.success)
			return json({ detail: "请求参数无效，请检查邮箱、链接或密码" }, 400);
		try {
			const subject =
				"email" in parsed.data ? parsed.data.email : "token-consume";
			const rate = await deps.limit(request, subject, action);
			if (!rate.ok)
				return json({ detail: "操作过于频繁，请稍后再试" }, 429, {
					"Retry-After": String(rate.retryAfterSeconds),
				});
			if (action === "request") {
				if (!deps.baseUrl || !deps.configured())
					return json({ detail: "邮件服务尚未配置，请联系管理员" }, 503);
				const command = requestSchema.parse(parsed.data);
				// Defer lookup as well as sending so response timing cannot reveal account existence.
				deps.defer(async () => {
					try {
						await deps.send(command);
					} catch {
						deps.report("account_email_send_failed");
					}
				});
				return json(
					{
						detail:
							"如果该邮箱已有可用账号，你会收到邮件。请检查收件箱及垃圾邮件。",
					},
					202,
				);
			}
			const command = consumeSchema.parse(parsed.data);
			if (command.purpose === "reset" && validatePassword(command.password))
				return json(
					{ detail: "密码需要 7–256 个字符，且同时包含大写和小写字母" },
					400,
				);
			const principal = await deps.consume(command);
			if (!principal)
				return json({ detail: "链接无效或已过期，请重新申请" }, 400);
			if (command.purpose === "reset") return json({ ok: true });
			const session = await deps.login(principal);
			if (!session)
				return json({ detail: "链接无效或账号不可用，请重新申请" }, 400);
			return json(session.identity, 200, { "set-cookie": session.cookie });
		} catch {
			deps.report("account_email_unavailable");
			return json({ detail: "服务暂不可用，请稍后重新申请链接" }, 503, {
				"Retry-After": "5",
			});
		}
	}
	return {
		request: handle.bind(null, "request"),
		consume: handle.bind(null, "consume"),
	};
}
