"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Purpose = "login" | "reset";
type Identity = { mustChangePassword?: boolean; session_created?: boolean };

const acceptedMessage =
	"如果该邮箱对应可用账户，你将收到一封邮件。请检查收件箱和垃圾邮件。";

export function AccountAccessForm() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const [purpose, setPurpose] = useState<Purpose>(
		searchParams.get("purpose") === "reset" ? "reset" : "login",
	);
	const [token, setToken] = useState<string | null>(null);
	const [ready, setReady] = useState(false);
	const initialized = useRef(false);
	const [error, setError] = useState<string | null>(null);
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
				setError("邮件链接无效，请重新申请。");
			}
		}
		setReady(true);
	}, []);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!ready || submitting || completed) return;
		setError(null);
		setMessage(null);
		const form = new FormData(event.currentTarget);
		const password = String(form.get("password") ?? "");
		if (token && purpose === "reset") {
			if (password.length < 7 || password.length > 256) {
				setError("新密码需要 7–256 个字符");
				return;
			}
			if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
				setError("新密码必须同时包含大写和小写字母");
				return;
			}
			if (password !== String(form.get("confirmation") ?? "")) {
				setError("两次输入的新密码不一致");
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
				setError("请求过于频繁，请稍后再试。");
				return;
			}
			if (response.status === 503) {
				setError(
					token
						? "服务暂时不可用，链接可能已失效，请重新申请邮件链接。"
						: "邮件服务暂时不可用，请稍后重试或使用密码登录。",
				);
				setToken(null);
				return;
			}
			if (!token) {
				if (response.status === 202) setMessage(acceptedMessage);
				else setError("暂时无法申请邮件链接，请稍后重试。");
				return;
			}
			if (!response.ok) {
				setError("邮件链接无效或已过期，请重新申请。");
				setToken(null);
				return;
			}
			if (purpose === "reset") {
				setToken(null);
				setCompleted(true);
				setMessage("密码已重置，请使用新密码登录。");
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
				setError("未能建立登录会话，请重新申请邮件链接或使用密码登录。");
				setToken(null);
				return;
			}
			setToken(null);
			setCompleted(true);
			router.replace(identity.mustChangePassword ? "/change-password" : "/app");
			router.refresh();
		} catch {
			setError("网络连接异常，请稍后重试；如链接已失效，请重新申请。");
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<div className="space-y-6">
			<h1 className="font-heading text-2xl font-semibold">
				{purpose === "reset" ? "重置密码" : "使用邮箱链接登录"}
			</h1>
			<form className="space-y-5" onSubmit={submit} aria-busy={submitting}>
				{!completed && !token ? (
					<div className="space-y-2">
						<Label htmlFor="email">邮箱</Label>
						<Input
							id="email"
							name="email"
							type="email"
							autoComplete="email"
							required
							disabled={!ready || submitting}
						/>
					</div>
				) : null}
				{!completed && token && purpose === "reset" ? (
					<>
						<div className="space-y-2">
							<Label htmlFor="password">新密码</Label>
							<Input
								id="password"
								name="password"
								type="password"
								autoComplete="new-password"
								minLength={7}
								maxLength={256}
								aria-describedby="password-requirements"
								required
								disabled={submitting}
							/>
							<p
								id="password-requirements"
								className="text-xs leading-5 text-muted-foreground"
							>
								7–256 个字符，同时包含大写和小写字母。
							</p>
						</div>
						<div className="space-y-2">
							<Label htmlFor="confirmation">确认新密码</Label>
							<Input
								id="confirmation"
								name="confirmation"
								type="password"
								autoComplete="new-password"
								minLength={7}
								maxLength={256}
								required
								disabled={submitting}
							/>
						</div>
					</>
				) : null}
				{error ? (
					<p className="text-sm leading-6 text-destructive" role="alert">
						{error}
					</p>
				) : null}
				{message ? (
					<p className="text-sm leading-6 text-muted-foreground" role="status">
						{message}
					</p>
				) : null}
				{!completed ? (
					<Button
						className="min-h-11 w-full"
						type="submit"
						disabled={!ready || submitting}
					>
						{submitting
							? "正在处理..."
							: token
								? purpose === "reset"
									? "重置密码"
									: "确认登录"
								: "发送邮件链接"}
					</Button>
				) : null}
			</form>
			{token ? (
				<Button
					className="min-h-11 w-full"
					variant="ghost"
					disabled={submitting}
					onClick={() => {
						setToken(null);
						setError(null);
						setMessage(null);
					}}
				>
					重新申请邮件链接
				</Button>
			) : null}
			<Link
				className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline"
				href="/login"
			>
				返回密码登录
			</Link>
		</div>
	);
}
