"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useInterfaceText } from "@/lib/i18n/provider";

export function ChangePasswordForm({ email }: { email: string | null }) {
	const t = useInterfaceText();
	const router = useRouter();
	const [error, setError] = useState<string | null>(null);
	const [errorField, setErrorField] = useState<
		"current_password" | "new_password" | "password_confirmation" | null
	>(null);
	const [submitting, setSubmitting] = useState(false);
	const [signingOut, setSigningOut] = useState(false);
	const [ready, setReady] = useState(false);
	useEffect(() => setReady(true), []);
	const busy = submitting || signingOut;

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!ready || busy) return;
		setError(null);
		setErrorField(null);
		const formElement = event.currentTarget;
		const form = new FormData(event.currentTarget);
		const currentPassword = String(form.get("current_password") ?? "");
		const newPassword = String(form.get("new_password") ?? "");
		const confirmation = String(form.get("password_confirmation") ?? "");
		function rejectField(
			field: "new_password" | "password_confirmation",
			message: string,
		) {
			setError(message);
			setErrorField(field);
			const input = formElement.elements.namedItem(field);
			if (input instanceof HTMLElement) input.focus();
		}
		if (newPassword.length < 7) {
			rejectField(
				"new_password",
				t(
					"新密码至少需要 7 个字符",
					"Use at least 7 characters for the new password.",
				),
			);
			return;
		}
		if (newPassword.length > 256) {
			rejectField(
				"new_password",
				t(
					"新密码最多允许 256 个字符",
					"Use at most 256 characters for the new password.",
				),
			);
			return;
		}
		if (!/[a-z]/.test(newPassword) || !/[A-Z]/.test(newPassword)) {
			rejectField(
				"new_password",
				t(
					"新密码必须同时包含大写和小写字母",
					"Use uppercase and lowercase letters in the new password.",
				),
			);
			return;
		}
		if (newPassword !== confirmation) {
			rejectField(
				"password_confirmation",
				t("两次输入的新密码不一致", "The new passwords don't match."),
			);
			return;
		}

		setSubmitting(true);
		try {
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
					"current password is incorrect": t(
						"当前密码不正确",
						"Incorrect current password.",
					),
					"password must be at least 7 characters": t(
						"新密码至少需要 7 个字符",
						"Use at least 7 characters for the new password.",
					),
					"password must contain uppercase and lowercase letters": t(
						"新密码必须同时包含大写和小写字母",
						"Use uppercase and lowercase letters in the new password.",
					),
					"password must be at most 256 characters": t(
						"新密码最多允许 256 个字符",
						"Use at most 256 characters for the new password.",
					),
					"new password must differ from the current password": t(
						"新密码不能与当前密码相同",
						"Choose a password different from your current password.",
					),
				};
				setError(
					(payload?.detail && messages[payload.detail]) ||
						t(
							"密码修改失败，请稍后重试",
							"Couldn't change the password. Try again later.",
						),
				);
				if (payload?.detail === "current password is incorrect") {
					setErrorField("current_password");
				} else if (payload?.detail && messages[payload.detail]) {
					setErrorField("new_password");
				}
				return;
			}

			router.replace("/app");
			router.refresh();
		} catch {
			setError(
				t(
					"网络连接异常，请稍后重试；若密码已更新，请使用新密码登录",
					"Couldn't connect. Try again, or sign in with your new password if it was updated.",
				),
			);
		} finally {
			setSubmitting(false);
		}
	}

	async function signOut() {
		if (!ready || busy) return;
		setSigningOut(true);
		setError(null);
		setErrorField(null);
		try {
			const response = await fetch("/api/auth/session", { method: "DELETE" });
			if (!response.ok) {
				setError(
					t("退出登录失败，请稍后重试", "Couldn't sign out. Try again later."),
				);
				return;
			}
			router.replace("/login");
			router.refresh();
		} catch {
			setError(
				t(
					"网络连接异常，尚未确认退出，请重试",
					"Connection failed. Sign-out was not confirmed. Try again.",
				),
			);
		} finally {
			setSigningOut(false);
		}
	}

	return (
		<form
			method="post"
			className="space-y-5"
			onSubmit={submit}
			aria-busy={busy}
		>
			{email ? (
				<p className="break-all border-y py-4 text-sm leading-6 text-muted-foreground">
					{email}
				</p>
			) : null}
			<div className="space-y-2">
				<Label htmlFor="current_password">
					{t("初始密码", "Initial password")}
				</Label>
				<Input
					id="current_password"
					name="current_password"
					type="password"
					autoComplete="current-password"
					className="h-11 px-3 text-base md:text-base motion-reduce:transition-none"
					disabled={!ready || busy}
					aria-invalid={errorField === "current_password" || undefined}
					aria-describedby={
						errorField === "current_password"
							? "current-password-error"
							: undefined
					}
					required
				/>
				<div className="min-h-6">
					{errorField === "current_password" && error ? (
						<p
							id="current-password-error"
							className="text-sm leading-6 text-destructive"
							role="alert"
						>
							{error}
						</p>
					) : null}
				</div>
			</div>
			<div className="space-y-2">
				<Label htmlFor="new_password">{t("新密码", "New password")}</Label>
				<Input
					id="new_password"
					name="new_password"
					type="password"
					autoComplete="new-password"
					className="h-11 px-3 text-base md:text-base motion-reduce:transition-none"
					disabled={!ready || busy}
					aria-invalid={errorField === "new_password" || undefined}
					aria-describedby={
						errorField === "new_password"
							? "new-password-hint new-password-error"
							: "new-password-hint"
					}
					minLength={7}
					maxLength={256}
					required
				/>
				<p
					id="new-password-hint"
					className="text-xs leading-5 text-muted-foreground"
				>
					{t(
						"至少 7 个字符，并同时包含大写和小写字母。",
						"Use at least 7 characters, with uppercase and lowercase letters.",
					)}
				</p>
				<div className="min-h-6">
					{errorField === "new_password" && error ? (
						<p
							id="new-password-error"
							className="text-sm leading-6 text-destructive"
							role="alert"
						>
							{error}
						</p>
					) : null}
				</div>
			</div>
			<div className="space-y-2">
				<Label htmlFor="password_confirmation">
					{t("确认新密码", "Confirm new password")}
				</Label>
				<Input
					id="password_confirmation"
					name="password_confirmation"
					type="password"
					autoComplete="new-password"
					className="h-11 px-3 text-base md:text-base motion-reduce:transition-none"
					disabled={!ready || busy}
					aria-invalid={errorField === "password_confirmation" || undefined}
					aria-describedby={
						errorField === "password_confirmation"
							? "password-confirmation-error"
							: undefined
					}
					minLength={7}
					maxLength={256}
					required
				/>
				<div className="min-h-6">
					{errorField === "password_confirmation" && error ? (
						<p
							id="password-confirmation-error"
							className="text-sm leading-6 text-destructive"
							role="alert"
						>
							{error}
						</p>
					) : null}
				</div>
			</div>
			<div className="min-h-6">
				{error && !errorField ? (
					<p className="text-sm leading-6 text-destructive" role="alert">
						{error}
					</p>
				) : null}
			</div>
			<Button className="h-11 w-full" type="submit" disabled={!ready || busy}>
				{submitting
					? t("正在保存...", "Saving...")
					: t("保存并进入 UnoRAG", "Save and enter UnoRAG")}
			</Button>
			<Button
				className="h-11 w-full"
				type="button"
				variant="ghost"
				onClick={signOut}
				disabled={!ready || busy}
			>
				{signingOut
					? t("正在退出...", "Signing out...")
					: t("退出登录", "Sign out")}
			</Button>
		</form>
	);
}
