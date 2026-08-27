import { publicAuthCapabilities } from "@/lib/server/auth/config";
import { LoginForm } from "./login-form";

const ERROR_MESSAGES: Record<string, string> = {
	oidc_unavailable: "企业登录服务暂时不可用，请稍后重试或使用本地管理员账号。",
	oidc_disabled: "企业登录尚未启用。",
	oidc_state_invalid: "登录请求已过期，请重新发起登录。",
	oidc_access_denied: "此企业账号尚未获得 UnoRAG 访问权限，请联系管理员邀请。",
	oidc_callback_failed: "企业身份验证失败，请重新尝试。",
};

export default async function LoginPage({
	searchParams,
}: {
	searchParams: Promise<{ error?: string }>;
}) {
	const query = await searchParams;
	const capabilities = publicAuthCapabilities();
	return (
		<LoginForm
			localEnabled={capabilities.local}
			oidcEnabled={capabilities.oidc}
			oidcLabel={capabilities.oidcLabel}
			initialError={query.error ? ERROR_MESSAGES[query.error] : undefined}
		/>
	);
}
