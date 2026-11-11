import "server-only";

import {
	type AccountEmailPurpose,
	type EmailTemplate,
	renderAccountEmail,
	renderInviteEmail,
} from "@/lib/server/email-templates";

export type EmailSendResult =
	| { sent: true; provider: "resend"; messageId?: string }
	| { sent: false; provider: "none" | "resend"; reason: string };

type EmailEnvironment = Readonly<Record<string, string | undefined>>;
export type EmailDependencies = {
	environment?: EmailEnvironment;
	fetch?: typeof fetch;
};

function emailConfiguration(environment: EmailEnvironment) {
	const provider = (environment.EMAIL_PROVIDER ?? "none").trim().toLowerCase();
	return {
		provider: provider === "resend" ? ("resend" as const) : ("none" as const),
		apiKey: environment.RESEND_API_KEY?.trim() ?? "",
		from: environment.EMAIL_FROM?.trim() ?? "",
	};
}

export function isEmailConfigured(
	env: EmailEnvironment = process.env,
): boolean {
	const { provider, apiKey, from } = emailConfiguration(env);
	return provider === "resend" && Boolean(apiKey && from);
}

function discardBody(
	response: Response | undefined,
	reader?: ReadableStreamDefaultReader<Uint8Array>,
): void {
	try {
		void (reader ?? response?.body)?.cancel().catch(() => {});
	} catch {
		// Cleanup must never expose provider content or delay the result.
	}
}

async function sendTransactionalEmail(
	input: {
		to: string;
		idempotencyKey?: string;
		render: () => EmailTemplate;
	},
	dependencies: EmailDependencies,
): Promise<EmailSendResult> {
	const { provider, apiKey, from } = emailConfiguration(
		dependencies.environment ?? process.env,
	);
	if (provider === "none") {
		return { sent: false, provider, reason: "EMAIL_PROVIDER=none" };
	}
	if (!apiKey || !from) {
		return {
			sent: false,
			provider,
			reason: "RESEND_API_KEY or EMAIL_FROM missing",
		};
	}
	const failure = (reason: string): EmailSendResult => ({
		sent: false,
		provider,
		reason,
	});
	if (
		input.idempotencyKey !== undefined &&
		(input.idempotencyKey.length === 0 ||
			input.idempotencyKey.length > 256 ||
			/[^\x21-\x7e]/.test(input.idempotencyKey))
	) {
		return failure("invalid_idempotency_key");
	}
	if (/\s/.test(input.to) || !/^[^\s<>@,;]+@[^\s<>@,;]+$/.test(input.to)) {
		return failure("invalid_recipient");
	}
	let template: EmailTemplate;
	try {
		template = input.render();
	} catch {
		return failure("invalid_email_template");
	}

	const controller = new AbortController();
	let response: Response | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<EmailSendResult>((resolve) => {
		timer = setTimeout(() => {
			resolve(failure("resend_timeout"));
			controller.abort();
			discardBody(response, reader);
		}, 5_000);
	});
	const send = async (): Promise<EmailSendResult> => {
		try {
			const headers: Record<string, string> = {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			};
			if (input.idempotencyKey !== undefined) {
				headers["Idempotency-Key"] = input.idempotencyKey;
			}
			response = await (dependencies.fetch ?? fetch)(
				"https://api.resend.com/emails",
				{
					method: "POST",
					headers,
					body: JSON.stringify({ from, to: [input.to], ...template }),
					signal: controller.signal,
					redirect: "error",
					cache: "no-store",
				},
			);
			if (controller.signal.aborted) {
				discardBody(response);
				return failure("resend_timeout");
			}
			if (!response.ok) {
				discardBody(response);
				return failure(`resend_http_${response.status}`);
			}
			let payload: unknown;
			try {
				reader = response.body?.getReader();
				if (!reader) return failure("resend_invalid_response");
				const decoder = new TextDecoder("utf-8", { fatal: true });
				let length = 0;
				let body = "";
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					length += value.byteLength;
					if (length > 16 * 1024) {
						discardBody(response, reader);
						return failure("resend_invalid_response");
					}
					body += decoder.decode(value, { stream: true });
				}
				if (controller.signal.aborted) return failure("resend_timeout");
				payload = JSON.parse(body + decoder.decode());
			} catch {
				discardBody(response, reader);
				return failure("resend_invalid_response");
			} finally {
				reader?.releaseLock();
				reader = undefined;
			}
			if (
				!payload ||
				typeof payload !== "object" ||
				!("id" in payload) ||
				typeof payload.id !== "string" ||
				payload.id.length !== 36 ||
				!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
					payload.id,
				)
			) {
				return failure("resend_invalid_response");
			}
			return { sent: true, provider: "resend", messageId: payload.id };
		} catch {
			return failure("resend_fetch_failed");
		}
	};
	try {
		// The race bounds even injected transports/body readers that ignore abort.
		return await Promise.race([deadline, send()]);
	} finally {
		clearTimeout(timer);
	}
}

export async function sendAccountEmail(
	input: {
		to: string;
		url: string;
		purpose: AccountEmailPurpose;
		idempotencyKey: string;
	},
	dependencies: EmailDependencies = {},
): Promise<EmailSendResult> {
	return sendTransactionalEmail(
		{
			to: input.to,
			idempotencyKey: input.idempotencyKey ?? "",
			render: () => renderAccountEmail(input),
		},
		dependencies,
	);
}

/** Optional delivery; existing callers may continue without an invite ID. */
export async function sendInviteEmail(
	input: {
		to: string;
		inviteUrl: string;
		workspaceName: string;
		role: string;
		inviteId?: string;
	},
	dependencies: EmailDependencies = {},
): Promise<EmailSendResult> {
	return sendTransactionalEmail(
		{
			to: input.to,
			idempotencyKey:
				input.inviteId === undefined
					? undefined
					: input.inviteId
						? `invite/${input.inviteId}`
						: "",
			render: () => renderInviteEmail(input),
		},
		dependencies,
	);
}
