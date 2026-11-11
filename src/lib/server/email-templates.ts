import "server-only";

export type EmailTemplate = { subject: string; html: string; text: string };
export type AccountEmailPurpose = "login" | "reset";

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => {
		switch (character) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&#39;";
		}
	});
}

// The application must supply a trusted URL, never one taken from user input or Host.
// Private HTTP origins remain valid for self-hosted installations.
function validateActionUrl(value: string): string {
	try {
		if (
			!/^https?:\/\/[^/?#]/i.test(value) ||
			/[\s\\]/.test(value) ||
			Array.from(value).some((character) => {
				const code = character.charCodeAt(0);
				return code < 32 || code === 127;
			})
		) {
			throw new Error();
		}
		const url = new URL(value);
		if (
			!url.hostname ||
			url.username ||
			url.password ||
			/^https?:\/\/[^/?#]*@/i.test(value)
		) {
			throw new Error();
		}
		return value;
	} catch {
		throw new Error("invalid_action_url");
	}
}

function renderEmail(input: {
	subject: string;
	heading: string;
	primaryText: string;
	secondaryText: string;
	actionLabel: string;
	actionUrl: string;
	footerText: string;
}): EmailTemplate {
	const url = validateActionUrl(input.actionUrl);
	const helper = "如果按钮无法打开，请复制下面的完整链接到浏览器地址栏。";
	const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(input.subject)}</title></head>
<body style="margin:0;padding:0;background-color:#f3f6f6;color:#243634;font-family:Arial,'Microsoft YaHei',sans-serif;letter-spacing:0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background-color:#ffffff;border:1px solid #d9e3e1;border-radius:8px;">
<tr><td style="padding:28px 24px 20px;border-top:4px solid #0f766e;border-bottom:1px solid #d9e3e1;">
<p style="margin:0 0 16px;color:#0f766e;font-size:22px;font-weight:bold;">UnoRAG</p>
<h1 style="margin:0;font-size:24px;line-height:1.4;overflow-wrap:anywhere;">${escapeHtml(input.heading)}</h1>
</td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.8;overflow-wrap:anywhere;">
<p style="margin:0 0 16px;">${escapeHtml(input.primaryText)}</p>
<p style="margin:0 0 24px;">${escapeHtml(input.secondaryText)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#0f766e" style="border-radius:6px;">
<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 24px;color:#ffffff;font-size:15px;font-weight:bold;text-decoration:none;">${escapeHtml(input.actionLabel)}</a>
</td></tr></table>
<p style="margin:24px 0 8px;color:#526864;font-size:12px;">${helper}</p>
<p style="margin:0;word-break:break-all;overflow-wrap:anywhere;font-size:13px;"><a href="${escapeHtml(url)}" rel="noopener noreferrer" style="color:#0f766e;">${escapeHtml(url)}</a></p>
</td></tr>
<tr><td style="padding:20px 24px;border-top:1px solid #d9e3e1;color:#526864;font-size:12px;line-height:1.8;">${escapeHtml(input.footerText)}</td></tr>
</table>
</td></tr></table>
</body></html>`;
	return {
		subject: input.subject.replace(/[\r\n\u2028\u2029]/g, " "),
		html,
		text: [
			"UnoRAG",
			input.heading,
			"",
			input.primaryText,
			input.secondaryText,
			"",
			input.actionLabel,
			url,
			"",
			helper,
			"",
			input.footerText,
		].join("\n"),
	};
}

export function renderAccountEmail(input: {
	url: string;
	purpose: AccountEmailPurpose;
}): EmailTemplate {
	if (input.purpose !== "login" && input.purpose !== "reset") {
		throw new Error("invalid_email_purpose");
	}
	const login = input.purpose === "login";
	return renderEmail({
		subject: login ? "你的 UnoRAG 登录链接" : "重置你的 UnoRAG 密码",
		heading: login ? "登录 UnoRAG" : "重置 UnoRAG 密码",
		primaryText: login
			? "我们收到了你的登录请求。请点击下方按钮继续登录 UnoRAG。"
			: "我们收到了重置密码的请求。请点击下方按钮为你的 UnoRAG 账户设置新密码。",
		secondaryText:
			"该链接在 15 分钟内有效，且只能使用一次。请勿转发或与他人分享。",
		actionLabel: login ? "登录 UnoRAG" : "重置密码",
		actionUrl: input.url,
		footerText: login
			? "若非本人发起登录请求，请忽略本邮件。"
			: "若非本人请求重置密码，请忽略本邮件，你的现有密码不会更改。",
	});
}

export function renderInviteEmail(input: {
	inviteUrl: string;
	workspaceName: string;
	role: string;
}): EmailTemplate {
	const roleLabels: Record<string, string> = {
		viewer: "查看者",
		editor: "编辑者",
		admin: "管理员",
		owner: "所有者",
	};
	const roleLabel = Object.hasOwn(roleLabels, input.role)
		? roleLabels[input.role]
		: input.role;
	return renderEmail({
		subject: `邀请加入 ${input.workspaceName} · UnoRAG`,
		heading: "加入 UnoRAG 工作区",
		primaryText: `你被邀请以「${roleLabel}」加入工作区「${input.workspaceName}」。`,
		secondaryText:
			"该邀请链接在 7 天内有效，且只能使用一次，请勿转发。首次使用请设置密码；已有账号请验证原密码后接受邀请。",
		actionLabel: "接受邀请",
		actionUrl: input.inviteUrl,
		footerText: "如果你不打算加入该工作区或不认识邀请人，请忽略本邮件。",
	});
}
