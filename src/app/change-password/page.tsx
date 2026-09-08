import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ChangePasswordForm } from "@/components/app/change-password-form";
import { UnoRAGLogo } from "@/components/app/unorag-logo";
import { resolveSessionCookieHeader } from "@/lib/server/auth/session";

export default async function ChangePasswordPage() {
	const cookieStore = await cookies();
	const identity = await resolveSessionCookieHeader(cookieStore.toString());
	if (!identity) redirect("/login");
	if (!identity.mustChangePassword) redirect("/app");

	return (
		<main className="grid min-h-dvh place-items-center bg-background px-6">
			<div className="w-full max-w-sm">
				<div className="mb-8 flex items-center gap-3">
					<UnoRAGLogo size="md" withWordmark />
				</div>
				<div className="mb-6 space-y-2">
					<h1 className="font-heading text-2xl font-semibold tracking-tight">
						设置你的管理员密码
					</h1>
					<p className="text-sm leading-6 text-muted-foreground">
						这是首次登录或管理员重置后的必要步骤。完成后才能进入工作区。
					</p>
				</div>
				<ChangePasswordForm email={identity.email} />
			</div>
		</main>
	);
}
