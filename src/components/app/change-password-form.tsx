"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ChangePasswordForm({ email }: { email: string | null }) {
	const router = useRouter();
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError(null);
		const form = new FormData(event.currentTarget);
		const currentPassword = String(form.get("current_password") ?? "");
		const newPassword = String(form.get("new_password") ?? "");
		const confirmation = String(form.get("password_confirmation") ?? "");
		if (newPassword.length < 7) {
			setError("新密码至少需要 7 个字符");
			return;
		}
		if (!/[a-z]/.test(newPassword) || !/[A-Z]/.test(newPassword)) {
			setError("新密码必须同时包含大写和小写字母");
			return;
		}
		if (newPassword !== confirmation) {
			setError("两次输入的新密码不一致");
			return;
		}

		setSubmitting(true);
		const response = await fetch("/api/auth/password", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				current_password: currentPassword,
				new_password: newPassword,
			}),
		});
		if (!response.ok) {
			const payload = (await response.json().catch(() => null)) as {
				detail?: string;
			} | null;
			const messages: Record<string, string> = {
				"current password is incorrect": "当前密码不正确",
				"password must be at least 7 characters": "新密码至少需要 7 个字符",
				"password must contain uppercase and lowercase letters":
					"新密码必须同时包含大写和小写字母",
				"password must be at most 256 characters": "新密码最多允许 256 个字符",
				"new password must differ from the current password":
					"新密码不能与当前密码相同",
			};
			setError(
				(payload?.detail && messages[payload.detail]) ||
					"密码修改失败，请稍后重试",
			);
			setSubmitting(false);
			return;
		}

		router.replace("/app");
		router.refresh();
	}

	async function signOut() {
		await fetch("/api/auth/session", { method: "DELETE" });
		router.replace("/login");
		router.refresh();
	}

	return (
		<form className="space-y-5" onSubmit={submit}>
			{email ? (
				<p className="font-mono text-xs text-muted-foreground">{email}</p>
			) : null}
			<div className="space-y-2">
				<Label htmlFor="current_password">初始密码</Label>
				<Input
					id="current_password"
					name="current_password"
					type="password"
					autoComplete="current-password"
					required
				/>
			</div>
			<div className="space-y-2">
				<Label htmlFor="new_password">新密码</Label>
				<Input
					id="new_password"
					name="new_password"
					type="password"
					autoComplete="new-password"
					minLength={7}
					maxLength={256}
					required
				/>
				<p className="text-xs text-muted-foreground">
					至少 7 个字符，并同时包含大写和小写字母。
				</p>
			</div>
			<div className="space-y-2">
				<Label htmlFor="password_confirmation">确认新密码</Label>
				<Input
					id="password_confirmation"
					name="password_confirmation"
					type="password"
					autoComplete="new-password"
					minLength={7}
					maxLength={256}
					required
				/>
			</div>
			{error ? (
				<p className="text-sm text-destructive" role="alert">
					{error}
				</p>
			) : null}
			<Button className="w-full" type="submit" disabled={submitting}>
				{submitting ? "正在保存..." : "保存并进入 UnoRAG"}
			</Button>
			<Button
				className="w-full"
				type="button"
				variant="ghost"
				onClick={signOut}
			>
				退出登录
			</Button>
		</form>
	);
}
