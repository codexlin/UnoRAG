"use client";

import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	InputOTP,
	InputOTPGroup,
	InputOTPSeparator,
	InputOTPSlot,
	REGEXP_ONLY_DIGITS,
} from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { useInterfaceText } from "@/lib/i18n/provider";

type Purpose = "login" | "reset";
type Identity = { mustChangePassword?: boolean; session_created?: boolean };
type ErrorField = "code" | "password" | "confirmation" | null;

export function AccountAccessForm() {
	const t = useInterfaceText();
	const acceptedMessage = t(
		"如果该邮箱对应可用账户，你将收到 6 位验证码和一次性链接。请检查收件箱和垃圾邮件。",
		"If the email belongs to an active account, you'll receive a 6-digit code and a sign-in link. Check your inbox and spam folder.",
	);
	const searchParams = useSearchParams();
	const [purpose, setPurpose] = useState<Purpose>(
		searchParams.get("purpose") === "reset" ? "reset" : "login",
	);
	const [token, setToken] = useState<string | null>(null);
	const [requestedEmail, setRequestedEmail] = useState<string | null>(null);
	const [code, setCode] = useState("");
	const [ready, setReady] = useState(false);
	const initialized = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const [errorField, setErrorField] = useState<ErrorField>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [completed, setCompleted] = useState(false);
	const [redirectTarget, setRedirectTarget] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [resending, setResending] = useState(false);

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

	const inCodeStep =
		!completed && !redirectTarget && !token && Boolean(requestedEmail);
	const busy = submitting || resending || Boolean(redirectTarget);

	async function sendRequestEmail(email: string) {
		const response = await fetch("/api/auth/email/request", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email, purpose }),
		});
		if (response.status === 429) {
			setError(
				t("请求过于频繁，请稍后再试。", "Too many requests. Try again later."),
			);
			return false;
		}
		if (response.status === 503) {
			setError(
				t(
					"邮件服务暂时不可用，请稍后重试或使用密码登录。",
					"Email is temporarily unavailable. Try again later or sign in with a password.",
				),
			);
			return false;
		}
		if (response.status === 202) {
			setRequestedEmail(email);
			setCode("");
			setMessage(acceptedMessage);
			return true;
		}
		setError(
			t(
				"暂时无法申请邮箱验证码，请稍后重试。",
				"Couldn't request an email code. Try again later.",
			),
		);
		return false;
	}

	async function resendCode() {
		if (!ready || busy || !requestedEmail) return;
		setError(null);
		setErrorField(null);
		setResending(true);
		try {
			await sendRequestEmail(requestedEmail);
		} catch {
			setError(
				t("网络连接异常，请稍后重试。", "Couldn't connect. Please try again."),
			);
		} finally {
			setResending(false);
		}
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!ready || busy || completed) return;
		setError(null);
		setErrorField(null);
		const formElement = event.currentTarget;
		const form = new FormData(formElement);
		const password = String(form.get("password") ?? "");
		const confirmation = String(form.get("confirmation") ?? "");
		const isConsume = Boolean(token || requestedEmail);

		function rejectField(field: Exclude<ErrorField, null>, msg: string) {
			setError(msg);
			setErrorField(field);
			const input = formElement.elements.namedItem(field);
			if (input instanceof HTMLElement) input.focus();
		}

		if (inCodeStep) {
			const trimmedCode = code.trim();
			if (!/^\d{6}$/.test(trimmedCode)) {
				rejectField(
					"code",
					t(
						"请输入完整的 6 位数字验证码。",
						"Enter the complete 6-digit verification code.",
					),
				);
				return;
			}
		}

		if (isConsume && purpose === "reset") {
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
			if (password !== confirmation) {
				rejectField(
					"confirmation",
					t("两次输入的新密码不一致", "The new passwords don't match."),
				);
				return;
			}
		}

		if (!isConsume) {
			setMessage(null);
			const email = String(form.get("email") ?? "").trim();
			setSubmitting(true);
			try {
				await sendRequestEmail(email);
			} catch {
				setError(
					t(
						"网络连接异常，请稍后重试；如链接已失效，请重新申请。",
						"Couldn't connect. Try again, or request a new code if this one expired.",
					),
				);
			} finally {
				setSubmitting(false);
			}
			return;
		}

		setSubmitting(true);
		let navigated = false;
		try {
			const payloadBody = token
				? {
						token,
						purpose,
						...(purpose === "reset" ? { password } : {}),
					}
				: {
						email: requestedEmail,
						code: code.trim(),
						purpose,
						...(purpose === "reset" ? { password } : {}),
					};
			const response = await fetch("/api/auth/email/consume", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payloadBody),
			});
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
					t(
						"服务暂时不可用，验证码或链接可能已失效，请重新申请。",
						"The service is temporarily unavailable. Request a new code or link and try again.",
					),
				);
				setToken(null);
				return;
			}
			if (!response.ok) {
				if (token) {
					setError(
						t(
							"邮件链接无效或已过期，请重新申请。",
							"The email link is invalid or expired. Request a new one.",
						),
					);
					setToken(null);
				} else {
					setError(
						t(
							"验证码无效或已过期，请核对后重试或重新发送。",
							"The verification code is invalid or expired. Check it or request a new one.",
						),
					);
					setErrorField("code");
					setCode("");
				}
				return;
			}
			if (purpose === "reset") {
				setToken(null);
				setRequestedEmail(null);
				setCode("");
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
						"未能建立登录会话，请重新申请或使用密码登录。",
						"Couldn't start a session. Request another code or sign in with a password.",
					),
				);
				setToken(null);
				return;
			}
			const target = identity.mustChangePassword
				? "/change-password"
				: "/app/ask";
			navigated = true;
			setToken(null);
			setRequestedEmail(null);
			setCode("");
			setMessage(null);
			setRedirectTarget(target);
			window.location.replace(target);
		} catch {
			setError(
				t(
					"网络连接异常，请稍后重试；如验证码或链接已失效，请重新申请。",
					"Couldn't connect. Try again, or request a new code if this one expired.",
				),
			);
		} finally {
			if (!navigated) setSubmitting(false);
		}
	}

	const inputClassName =
		"h-11 bg-background px-3.5 text-base shadow-2xs md:text-base dark:bg-muted/35 motion-reduce:transition-none";

	return (
		<div className="space-y-6">
			<div className="space-y-1.5">
				<h1 className="text-2xl font-semibold leading-8 tracking-[-0.02em] text-card-foreground">
					{purpose === "reset"
						? t("重置密码", "Reset password")
						: t("使用邮箱登录", "Sign in with email")}
				</h1>
				<p className="text-sm leading-6 text-muted-foreground">
					{redirectTarget
						? redirectTarget === "/change-password"
							? t(
									"验证成功，正在前往设置新密码。",
									"Verified. Opening password setup.",
								)
							: t(
									"验证成功，正在进入工作区。",
									"Verified. Entering your workspace.",
								)
						: completed
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
								: inCodeStep
									? purpose === "reset"
										? t(
												"输入邮件中的 6 位验证码并设置新密码，也可在同一台设备上直接点击邮件链接。",
												"Enter the 6-digit code from your email and choose a new password, or open the link on this device.",
											)
										: t(
												"输入邮件中的 6 位验证码即可在当前设备登录，也可在同一台设备上直接点击邮件链接。",
												"Enter the 6-digit code from your email to sign in on this device, or open the link here.",
											)
									: purpose === "reset"
										? t(
												"输入账号邮箱，获取 6 位验证码和密码重置链接。",
												"Enter your account email to receive a 6-digit code and password reset link.",
											)
										: t(
												"输入账号邮箱，获取 6 位一次性验证码和登录链接。",
												"Enter your account email to receive a 6-digit verification code and sign-in link.",
											)}
				</p>
			</div>

			{redirectTarget ? (
				<div
					role="status"
					aria-live="polite"
					className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 px-3.5 py-3 text-sm leading-6 text-foreground"
				>
					<Loader2
						className="mt-1 size-4 shrink-0 animate-spin text-primary motion-reduce:hidden"
						aria-hidden
					/>
					<span>
						{redirectTarget === "/change-password"
							? t(
									"正在前往修改密码，请稍候…",
									"Opening password setup, please wait…",
								)
							: t(
									"正在进入工作区，请稍候…",
									"Entering workspace, please wait…",
								)}
					</span>
				</div>
			) : message ? (
				<div
					role="status"
					className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 px-3.5 py-3 text-sm leading-6 text-foreground"
				>
					<CheckCircle2
						className="mt-1 size-4 shrink-0 text-cite"
						aria-hidden
					/>
					<span>{message}</span>
				</div>
			) : null}

			<form
				method="post"
				className="space-y-4"
				onSubmit={submit}
				aria-busy={busy}
			>
				{!completed && !redirectTarget && !token && !inCodeStep ? (
					<div className="space-y-2">
						<Label htmlFor="email">{t("邮箱", "Email")}</Label>
						<Input
							id="email"
							name="email"
							type="email"
							autoComplete="email"
							className={inputClassName}
							aria-invalid={Boolean(error && !errorField) || undefined}
							aria-describedby={
								error && !errorField ? "account-access-error" : undefined
							}
							required
							disabled={!ready || busy}
						/>
					</div>
				) : null}

				{inCodeStep ? (
					<>
						<div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/80 bg-muted/25 px-3 py-1.5 text-sm">
							<span className="min-w-0 truncate text-muted-foreground">
								{requestedEmail}
							</span>
							<Button
								type="button"
								variant="ghost"
								className="h-11 px-2.5 text-xs text-muted-foreground hover:text-foreground"
								disabled={busy}
								onClick={() => {
									setRequestedEmail(null);
									setCode("");
									setError(null);
									setErrorField(null);
									setMessage(null);
								}}
							>
								{t("更换邮箱", "Change email")}
							</Button>
						</div>
						<div className="space-y-2">
							<Label htmlFor="email-otp-code">
								{t("6 位验证码", "6-digit code")}
							</Label>
							<InputOTP
								id="email-otp-code"
								name="code"
								maxLength={6}
								pattern={REGEXP_ONLY_DIGITS}
								inputMode="numeric"
								autoComplete="one-time-code"
								containerClassName="w-full justify-between gap-1.5 sm:gap-2"
								value={code}
								onChange={(value) => {
									setCode(value);
									if (errorField === "code") {
										setError(null);
										setErrorField(null);
									}
								}}
								aria-invalid={errorField === "code" || undefined}
								aria-describedby={
									errorField === "code" ? "account-code-error" : undefined
								}
								disabled={!ready || busy}
							>
								<InputOTPGroup className="min-w-0 flex-1">
									<InputOTPSlot
										index={0}
										className="h-11 w-full min-w-0 flex-1"
									/>
									<InputOTPSlot
										index={1}
										className="h-11 w-full min-w-0 flex-1"
									/>
									<InputOTPSlot
										index={2}
										className="h-11 w-full min-w-0 flex-1"
									/>
								</InputOTPGroup>
								<InputOTPSeparator />
								<InputOTPGroup className="min-w-0 flex-1">
									<InputOTPSlot
										index={3}
										className="h-11 w-full min-w-0 flex-1"
									/>
									<InputOTPSlot
										index={4}
										className="h-11 w-full min-w-0 flex-1"
									/>
									<InputOTPSlot
										index={5}
										className="h-11 w-full min-w-0 flex-1"
									/>
								</InputOTPGroup>
							</InputOTP>
							{errorField === "code" && error ? (
								<p
									id="account-code-error"
									className="inline-flex items-center gap-1.5 text-sm leading-6 text-destructive"
									role="alert"
								>
									<AlertCircle className="size-4 shrink-0" aria-hidden />
									<span>{error}</span>
								</p>
							) : null}
						</div>
					</>
				) : null}

				{!completed && (token || inCodeStep) && purpose === "reset" ? (
					<>
						<div className="space-y-2">
							<Label htmlFor="password">{t("新密码", "New password")}</Label>
							<Input
								id="password"
								name="password"
								type="password"
								autoComplete="new-password"
								className={inputClassName}
								minLength={7}
								maxLength={256}
								aria-invalid={errorField === "password" || undefined}
								aria-describedby={
									errorField === "password"
										? "password-requirements account-password-error"
										: "password-requirements"
								}
								required
								disabled={busy}
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
							{errorField === "password" && error ? (
								<p
									id="account-password-error"
									className="inline-flex items-center gap-1.5 text-sm leading-6 text-destructive"
									role="alert"
								>
									<AlertCircle className="size-4 shrink-0" aria-hidden />
									<span>{error}</span>
								</p>
							) : null}
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
								className={inputClassName}
								aria-invalid={errorField === "confirmation" || undefined}
								aria-describedby={
									errorField === "confirmation"
										? "account-confirmation-error"
										: undefined
								}
								minLength={7}
								maxLength={256}
								required
								disabled={busy}
							/>
							{errorField === "confirmation" && error ? (
								<p
									id="account-confirmation-error"
									className="inline-flex items-center gap-1.5 text-sm leading-6 text-destructive"
									role="alert"
								>
									<AlertCircle className="size-4 shrink-0" aria-hidden />
									<span>{error}</span>
								</p>
							) : null}
						</div>
					</>
				) : null}

				{error && !errorField ? (
					<p
						id="account-access-error"
						className="inline-flex items-center gap-1.5 text-sm leading-6 text-destructive"
						role="alert"
					>
						<AlertCircle className="size-4 shrink-0" aria-hidden />
						<span>{error}</span>
					</p>
				) : null}

				{!completed && !redirectTarget ? (
					<div className="space-y-2 pt-1">
						<Button
							className="h-11 w-full text-sm font-medium shadow-2xs"
							type="submit"
							disabled={!ready || busy}
						>
							{submitting ? (
								<>
									<Loader2
										className="size-4 animate-spin motion-reduce:hidden"
										aria-hidden
									/>
									{t("正在处理...", "Processing...")}
								</>
							) : token ? (
								purpose === "reset" ? (
									t("重置密码", "Reset password")
								) : (
									t("确认登录", "Confirm sign-in")
								)
							) : inCodeStep ? (
								purpose === "reset" ? (
									t("验证并重置密码", "Verify and reset password")
								) : (
									t("验证并登录", "Verify and sign in")
								)
							) : (
								t("发送验证码与链接", "Send code & link")
							)}
						</Button>
						{inCodeStep ? (
							<Button
								className="h-11 w-full"
								type="button"
								variant="ghost"
								disabled={!ready || busy}
								onClick={resendCode}
							>
								{resending
									? t("正在重新发送...", "Resending...")
									: t("重新发送验证码", "Resend code")}
							</Button>
						) : null}
					</div>
				) : null}
			</form>

			{token ? (
				<Button
					className="h-11 w-full"
					type="button"
					variant="ghost"
					disabled={busy}
					onClick={() => {
						setToken(null);
						setRequestedEmail(null);
						setCode("");
						setError(null);
						setErrorField(null);
						setMessage(null);
					}}
				>
					{t("重新申请验证码或链接", "Request another code or link")}
				</Button>
			) : null}

			<div className="border-t border-border pt-4">
				<Link
					className="inline-flex min-h-11 items-center rounded-md text-sm text-muted-foreground underline-offset-4 transition-colors duration-150 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring motion-reduce:transition-none"
					href="/login"
				>
					{t("返回密码登录", "Back to password sign-in")}
				</Link>
			</div>
		</div>
	);
}
