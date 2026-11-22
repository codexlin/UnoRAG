"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useInterfaceText } from "@/lib/i18n/provider";

type Purpose = "login" | "reset";
type Identity = { mustChangePassword?: boolean; session_created?: boolean };

export function AccountAccessForm() {
	const t = useInterfaceText();
	const acceptedMessage = t(
		"如果该邮箱对应可用账户，你将收到一封邮件。请检查收件箱和垃圾邮件。",
		"If the email belongs to an active account, you'll receive a link. Check your inbox and spam folder.",
	);
	const router = useRouter();
	const searchParams = useSearchParams();
	const [purpose, setPurpose] = useState<Purpose>(
		searchParams.get("purpose") === "reset" ? "reset" : "login",
	);
	const [token, setToken] = useState<string | null>(null);
	const [ready, setReady] = useState(false);
	const initialized = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const [errorField, setErrorField] = useState<
		"password" | "confirmation" | null
	>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [completed, setCompleted] = useState(false);
	const [submitting, setSubmitting] = useState(false);

	useEffect(() => {
		// Preserve the in-memory token across Strict Mode's effect replay.
		if (initialized.current) return;
		initialized.current = true;
		const hash = window.location.hash;
		if (hash) {
			window.history.replaceState(
				window.history.state,
				"",
				`${window.location.pathname}${window.location.search}`,
			);
			const params = new URLSearchParams(hash.slice(1));
			const hashToken = params.get("token");
			const hashPurpose = params.get("purpose");
			if (hashToken && (hashPurpose === "login" || hashPurpose === "reset")) {
				setToken(hashToken);
				setPurpose(hashPurpose);
			} else {
				setError(
					t(
						"邮件链接无效，请重新申请。",
						"The email link is invalid. Request a new one.",
					),
				);
			}
		}
		setReady(true);
	}, [t]);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!ready || submitting || completed) return;
		setError(null);
		setErrorField(null);
		setMessage(null);
		const formElement = event.currentTarget;
		const form = new FormData(event.currentTarget);
		const password = String(form.get("password") ?? "");
		function rejectField(field: "password" | "confirmation", message: string) {
			setError(message);
			setErrorField(field);
			const input = formElement.elements.namedItem(field);
			if (input instanceof HTMLElement) input.focus();
		}
		if (token && purpose === "reset") {
			if (password.length < 7 || password.length > 256) {
				rejectField(
					"password",
					t(
						"新密码需要 7–256 个字符",
						"Use 7–256 characters for the new password.",
					),
				);
				return;
			}
			if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
				rejectField(
					"password",
					t(
						"新密码必须同时包含大写和小写字母",
						"Use uppercase and lowercase letters in the new password.",
					),
				);
				return;
			}
			if (password !== String(form.get("confirmation") ?? "")) {
				rejectField(
					"confirmation",
					t("两次输入的新密码不一致", "The new passwords don't match."),
				);
				return;
			}
		}

		setSubmitting(true);
		try {
			const response = await fetch(
				token ? "/api/auth/email/consume" : "/api/auth/email/request",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(
						token
							? {
									token,
									purpose,
									...(purpose === "reset" ? { password } : {}),
								}
							: { email: String(form.get("email") ?? "").trim(), purpose },
					),
				},
			);
			if (response.status === 429) {
				setError(
					t(
						"请求过于频繁，请稍后再试。",
						"Too many requests. Try again later.",
					),
				);
				return;
			}
			if (response.status === 503) {
				setError(
					token
						? t(
								"服务暂时不可用，链接可能已失效，请重新申请邮件链接。",
								"The service is temporarily unavailable. The link may have expired; request a new one.",
							)
						: t(
								"邮件服务暂时不可用，请稍后重试或使用密码登录。",
								"Email is temporarily unavailable. Try again later or sign in with a password.",
							),
				);
				setToken(null);
				return;
			}
			if (!token) {
				if (response.status === 202) setMessage(acceptedMessage);
				else
					setError(
						t(
							"暂时无法申请邮件链接，请稍后重试。",
							"Couldn't request an email link. Try again later.",
						),
					);
				return;
			}
			if (!response.ok) {
				setError(
					t(
						"邮件链接无效或已过期，请重新申请。",
						"The email link is invalid or expired. Request a new one.",
					),
				);
				setToken(null);
				return;
			}
			if (purpose === "reset") {
				setToken(null);
				setCompleted(true);
				setMessage(
					t(
						"密码已重置，请使用新密码登录。",
						"Password reset. Sign in with your new password.",
					),
				);
				return;
			}
			const payload = (await response.json()) as Identity & {
				identity?: Identity;
			};
			const identity = payload.identity ?? payload;
			if (
				payload.session_created === false ||
				identity.session_created === false
			) {
				setError(
					t(
						"未能建立登录会话，请重新申请邮件链接或使用密码登录。",
						"Couldn't start a session. Request another email link or sign in with a password.",
					),
				);
				setToken(null);
				return;
			}
			setToken(null);
			setCompleted(true);
			router.replace(identity.mustChangePassword ? "/change-password" : "/app");
			router.refresh();
		} catch {
			setError(
				t(
					"网络连接异常，请稍后重试；如链接已失效，请重新申请。",
					"Couldn't connect. Try again, or request a new link if this one expired.",
				),
			);
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<div className="space-y-8">
			<div className="space-y-2">
				<h1 className="text-2xl font-semibold leading-8">
					{purpose === "reset"
						? t("重置密码", "Reset password")
						: t("使用邮箱链接登录", "Sign in with an email link")}
				</h1>
				<p className="text-sm leading-6 text-muted-foreground">
					{completed
						? t("账号访问已更新。", "Account access updated.")
						: token
							? purpose === "reset"
								? t(
										"设置新密码后，请重新登录。",
										"Sign in again after setting your new password.",
									)
								: t(
										"确认后将使用此邮件链接登录。链接仅可使用一次。",
										"Confirm to sign in with this single-use link.",
									)
							: purpose === "reset"
								? t(
										"输入账号邮箱，申请密码重置链接。",
										"Enter your account email to request a password reset link.",
									)
								: t(
										"输入账号邮箱，申请一次性登录链接。",
										"Enter your account email to request a single-use sign-in link.",
									)}
				</p>
			</div>
			<form
				method="post"
				className="space-y-5"
				onSubmit={submit}
				aria-busy={submitting}
			>
				{!completed && !token ? (
					<div className="space-y-2">
						<Label htmlFor="email">{t("邮箱", "Email")}</Label>
						<Input
							id="email"
							name="email"
							type="email"
							autoComplete="email"
							className="h-11 px-3 text-base md:text-base motion-reduce:transition-none"
							aria-describedby={
								error && !errorField ? "account-access-error" : undefined
							}
							required
							disabled={!ready || submitting}
						/>
					</div>
				) : null}
				{!completed && token && purpose === "reset" ? (
					<>
						<div className="space-y-2">
							<Label htmlFor="password">{t("新密码", "New password")}</Label>
							<Input
								id="password"
								name="password"
								type="password"
								autoComplete="new-password"
								className="h-11 px-3 text-base md:text-base motion-reduce:transition-none"
								minLength={7}
								maxLength={256}
								aria-invalid={errorField === "password" || undefined}
								aria-describedby={
									errorField === "password"
										? "password-requirements account-password-error"
										: "password-requirements"
								}
								required
								disabled={submitting}
							/>
							<p
								id="password-requirements"
								className="text-xs leading-5 text-muted-foreground"
							>
								{t(
									"7–256 个字符，同时包含大写和小写字母。",
									"Use 7–256 characters, with uppercase and lowercase letters.",
								)}
							</p>
							<div className="min-h-6">
								{errorField === "password" && error ? (
									<p
										id="account-password-error"
										className="text-sm leading-6 text-destructive"
										role="alert"
									>
										{error}
									</p>
								) : null}
							</div>
						</div>
						<div className="space-y-2">
							<Label htmlFor="confirmation">
								{t("确认新密码", "Confirm new password")}
							</Label>
							<Input
								id="confirmation"
								name="confirmation"
								type="password"
								autoComplete="new-password"
								className="h-11 px-3 text-base md:text-base motion-reduce:transition-none"
								aria-invalid={errorField === "confirmation" || undefined}
								aria-describedby={
									errorField === "confirmation"
										? "account-confirmation-error"
										: undefined
								}
								minLength={7}
								maxLength={256}
								required
								disabled={submitting}
							/>
							<div className="min-h-6">
								{errorField === "confirmation" && error ? (
									<p
										id="account-confirmation-error"
										className="text-sm leading-6 text-destructive"
										role="alert"
									>
										{error}
									</p>
								) : null}
							</div>
						</div>
					</>
				) : null}
				<div className="min-h-6">
					{error && !errorField ? (
						<p
							id="account-access-error"
							className="text-sm leading-6 text-destructive"
							role="alert"
						>
							{error}
						</p>
					) : null}
				</div>
				{message ? (
					<p className="text-sm leading-6 text-muted-foreground" role="status">
						{message}
					</p>
				) : null}
				{!completed ? (
					<Button
						className="h-11 w-full"
						type="submit"
						disabled={!ready || submitting}
					>
						{submitting
							? t("正在处理...", "Processing...")
							: token
								? purpose === "reset"
									? t("重置密码", "Reset password")
									: t("确认登录", "Confirm sign-in")
								: t("发送邮件链接", "Send email link")}
					</Button>
				) : null}
			</form>
			{token ? (
				<Button
					className="h-11 w-full"
					variant="ghost"
					disabled={submitting}
					onClick={() => {
						setToken(null);
						setError(null);
						setErrorField(null);
						setMessage(null);
					}}
				>
					{t("重新申请邮件链接", "Request another email link")}
				</Button>
			) : null}
			<div className="border-t pt-4">
				<Link
					className="inline-flex min-h-11 items-center rounded-md text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
					href="/login"
				>
					{t("返回密码登录", "Back to password sign-in")}
				</Link>
			</div>
		</div>
	);
}
