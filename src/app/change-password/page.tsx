import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AuthPageShell } from "@/components/app/auth-page-shell";
import { ChangePasswordForm } from "@/components/app/change-password-form";
import { resolveSessionCookieHeader } from "@/lib/server/auth/session";

export default async function ChangePasswordPage() {
	const cookieStore = await cookies();
	const identity = await resolveSessionCookieHeader(cookieStore.toString());
	if (!identity) redirect("/login");
	if (!identity.mustChangePassword) redirect("/app");

	return (
		<AuthPageShell>
			<div className="space-y-2">
				<h1 className="text-2xl font-semibold leading-8">设置你的管理员密码</h1>
				<p className="text-sm leading-6 text-muted-foreground">
					这是首次登录或管理员重置后的必要步骤。完成后才能进入工作区。
				</p>
			</div>
			<ChangePasswordForm email={identity.email} />
		</AuthPageShell>
	);
}
