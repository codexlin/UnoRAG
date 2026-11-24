"use client";

import { AlertCircle, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { AuthPageShell } from "@/components/app/auth-page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useInterfaceText } from "@/lib/i18n/provider";

const ERROR_COPY = {
	credentials: ["邮箱或密码不正确", "Incorrect email or password"],
	rate_limit: [
		"登录尝试过多，请稍后再试",
		"Too many sign-in attempts. Try again later.",
	],
	unavailable: ["登录服务暂时不可用", "Sign-in is temporarily unavailable."],
	network: ["网络连接异常，请稍后重试", "Connection failed. Please try again."],
} as const;

function LoginFormPlaceholder() {
	const t = useInterfaceText();
	return (
		<div
			role="status"
			aria-label={t("正在加载登录表单", "Loading sign-in form")}
		>
			<div aria-hidden>
				<div className="space-y-4">
					{[0, 1].map((field) => (
						<div key={field} className="space-y-2">
							<div className="h-3.5 w-10 rounded-sm bg-muted" />
							<div className="h-11 rounded-lg border border-input bg-background dark:bg-muted/35" />
						</div>
					))}
				</div>
				<div className="mt-2 mb-3 min-h-6" />
				<div className="h-11 rounded-lg bg-muted" />
			</div>
			<noscript>
				<p role="alert" className="mt-3 text-sm text-destructive">
					{t("登录需要启用 JavaScript。", "Sign-in requires JavaScript.")}
				</p>
			</noscript>
		</div>
	);
}

export default function LoginPage() {
	const t = useInterfaceText();
	const router = useRouter();
	const [error, setError] = useState<keyof typeof ERROR_COPY | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [ready, setReady] = useState(false);
	useEffect(() => setReady(true), []);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!ready || submitting) return;
		setSubmitting(true);
		setError(null);
		const form = new FormData(event.currentTarget);
		try {
			const response = await fetch("/api/auth/session", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					email: form.get("email"),
					password: form.get("password"),
				}),
			});
			if (!response.ok) {
				setError(
					response.status === 401
						? "credentials"
						: response.status === 429
							? "rate_limit"
							: "unavailable",
				);
				return;
			}
			const identity = (await response.json()) as {
				mustChangePassword?: boolean;
			};
			router.replace(identity.mustChangePassword ? "/change-password" : "/app");
			router.refresh();
		} catch {
			setError("network");
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<AuthPageShell>
			<div className="space-y-1.5">
				<h1 className="text-2xl font-semibold leading-8 tracking-[-0.02em] text-card-foreground">
					{t("登录 UnoRAG", "Sign in to UnoRAG")}
				</h1>
				<p className="text-sm leading-6 text-muted-foreground">
					{t(
						"使用你的工作区账号登录。",
						"Use your workspace account to sign in.",
					)}
				</p>
			</div>
			{/* Password managers may insert sibling controls before hydration. */}
			{!ready ? (
				<LoginFormPlaceholder />
			) : (
				<form method="post" onSubmit={submit} aria-busy={submitting}>
					<div className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="email">{t("邮箱", "Email")}</Label>
							<Input
								id="email"
								name="email"
								type="email"
								autoComplete="username"
								placeholder="admin@unorag.local"
								className="h-11 bg-background px-3.5 text-base shadow-2xs md:text-base dark:bg-muted/35 motion-reduce:transition-none"
								aria-invalid={error === "credentials" || undefined}
								aria-describedby={error ? "login-error" : undefined}
								disabled={submitting}
								required
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="password">{t("密码", "Password")}</Label>
							<Input
								id="password"
								name="password"
								type="password"
								autoComplete="current-password"
								className="h-11 bg-background px-3.5 text-base shadow-2xs md:text-base dark:bg-muted/35 motion-reduce:transition-none"
								aria-invalid={error === "credentials" || undefined}
								aria-describedby={error ? "login-error" : undefined}
								disabled={submitting}
								required
							/>
						</div>
					</div>
					<div className="mt-2 mb-3 flex min-h-6 items-center">
						{error ? (
							<p
								id="login-error"
								className="inline-flex items-center gap-1.5 text-sm leading-6 text-destructive"
								role="alert"
							>
								<AlertCircle className="size-4 shrink-0" aria-hidden />
								<span>{t(ERROR_COPY[error][0], ERROR_COPY[error][1])}</span>
							</p>
						) : null}
					</div>
					<Button
						className="h-11 w-full text-sm font-medium shadow-2xs"
						type="submit"
						disabled={!ready || submitting}
					>
						{submitting ? (
							<>
								<Loader2
									className="size-4 animate-spin motion-reduce:hidden"
									aria-hidden
								/>
								{t("正在登录...", "Signing in...")}
							</>
						) : (
							t("登录", "Sign in")
						)}
					</Button>
				</form>
			)}
			<nav
				aria-label={t("其他登录方式", "Other sign-in options")}
				className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border pt-4 text-sm"
			>
				<Link
					className="inline-flex min-h-11 min-w-11 items-center rounded-md text-card-foreground underline-offset-4 transition-colors duration-150 hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring motion-reduce:transition-none"
					href="/account-access?purpose=login"
				>
					{t("使用邮箱登录", "Sign in with email")}
				</Link>
				<Link
					className="inline-flex min-h-11 min-w-11 items-center rounded-md text-muted-foreground underline-offset-4 transition-colors duration-150 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring motion-reduce:transition-none"
					href="/account-access?purpose=reset"
				>
					{t("忘记密码", "Forgot password")}
				</Link>
			</nav>
		</AuthPageShell>
	);
}
