import "server-only";

export type EmailSendResult =
	| { sent: true; provider: "resend" }
	| { sent: false; provider: "none" | "resend"; reason: string };

function emailProvider(): "none" | "resend" {
	const raw = (process.env.EMAIL_PROVIDER ?? "none").trim().toLowerCase();
	return raw === "resend" ? "resend" : "none";
}

/**
 * Optional invite delivery. Default is none — UI always exposes copyable invite_url.
 */
export async function sendInviteEmail(input: {
	to: string;
	inviteUrl: string;
	workspaceName: string;
	role: string;
}): Promise<EmailSendResult> {
	const provider = emailProvider();
	if (provider === "none") {
		return { sent: false, provider: "none", reason: "EMAIL_PROVIDER=none" };
	}

	const apiKey = process.env.RESEND_API_KEY?.trim() ?? "";
	const from = process.env.EMAIL_FROM?.trim() ?? "";
	if (!apiKey || !from) {
		return {
			sent: false,
			provider: "resend",
			reason: "RESEND_API_KEY or EMAIL_FROM missing",
		};
	}

	const subject = `邀请加入 ${input.workspaceName} · UnoRAG`;
	const text = [
		`你被邀请以「${input.role}」加入工作区「${input.workspaceName}」。`,
		"",
		"打开以下链接接受邀请并设置密码（链接有有效期，且只能使用一次）：",
		input.inviteUrl,
		"",
		"若非本人操作，请忽略本邮件。",
	].join("\n");

	try {
		const response = await fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				from,
				to: [input.to],
				subject,
				text,
			}),
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			return {
				sent: false,
				provider: "resend",
				reason: `resend_http_${response.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`,
			};
		}
		return { sent: true, provider: "resend" };
	} catch (error) {
		return {
			sent: false,
			provider: "resend",
			reason: error instanceof Error ? error.message : "resend_fetch_failed",
		};
	}
}
