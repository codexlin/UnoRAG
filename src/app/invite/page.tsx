"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, Suspense, useEffect, useRef, useState } from "react";

import { AuthPageShell } from "@/components/app/auth-page-shell";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Preview = {
	email: string;
	role: string;
	workspaceName: string;
	expiresAt: string;
	status: string;
	existingAccount: boolean;
};

function InviteForm() {
	const router = useRouter();
	const [token, setToken] = useState<string | null>(null);
	const initialized = useRef(false);
	const [preview, setPreview] = useState<Preview | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [passwordError, setPasswordError] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const submitAttempt = useRef<AbortController | null>(null);

	useEffect(() => {
		setSubmitting(false);
		return () => {
			const attempt = submitAttempt.current;
			submitAttempt.current = null;
			// Cancel client work, not membership or a session already accepted by the server.
			attempt?.abort();
		};
	}, []);

	useEffect(() => {
		if (initialized.current) return;
		initialized.current = true;
		const url = new URL(window.location.href);
		const hash = url.hash;
		const legacyToken = url.searchParams.get("token");
		url.hash = "";
		url.searchParams.delete("token");
		window.history.replaceState(
			window.history.state,
			"",
			`${url.pathname}${url.search}`,
		);
		// Legacy query URLs also live in Next's history tree until a clean navigation.
		if (legacyToken !== null)
			router.replace(`${url.pathname}${url.search}`, { scroll: false });
		setToken(
			(
				new URLSearchParams(hash.slice(1)).get("token") ??
				legacyToken ??
				""
			).trim(),
		);
	}, [router]);

	useEffect(() => {
		if (token === null) return;
		setPreview(null);
		setLoadError(null);
		if (!token) {
			setLoadError("缺少邀请链接");
			return;
		}
		const controller = new AbortController();
		(async () => {
			try {
				const response = await fetch("/api/auth/invite/preview", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ token }),
					signal: controller.signal,
				});
				if (controller.signal.aborted) return;
				if (!response.ok) {
					setLoadError(
						response.status === 404 ? "邀请不存在或已失效" : "无法加载邀请",
					);
					return;
				}
				const data = (await response.json()) as Preview;
				if (controller.signal.aborted) return;
				if (data.status !== "pending") {
					setLoadError(
						data.status === "expired"
							? "邀请已过期，请联系管理员重新邀请"
							: `邀请状态：${data.status}`,
					);
					return;
				}
				setPreview(data);
			} catch {
				if (!controller.signal.aborted)
					setLoadError("网络连接失败，请重新打开邀请链接重试");
			}
		})();
		return () => controller.abort();
	}, [token]);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!token || !preview || submitting || submitAttempt.current) return;
		setSubmitting(true);
		setError(null);
		setPasswordError(false);
		const passwordInput = event.currentTarget.elements.namedItem("password");
		function rejectPassword(message: string) {
			setError(message);
			setPasswordError(true);
			setSubmitting(false);
			if (passwordInput instanceof HTMLElement) passwordInput.focus();
		}
		const form = new FormData(event.currentTarget);
		const password = String(form.get("password") ?? "");
		if (
			!preview.existingAccount &&
			(password.length < 7 || password.length > 256)
		) {
			rejectPassword("密码需要 7–256 个字符");
			return;
		}
		if (
			!preview.existingAccount &&
			(!/[a-z]/.test(password) || !/[A-Z]/.test(password))
		) {
			rejectPassword("密码必须同时包含大写和小写字母");
			return;
		}
		const attempt = new AbortController();
		submitAttempt.current = attempt;
		const isCurrent = () =>
			submitAttempt.current === attempt && !attempt.signal.aborted;
		try {
			const response = await fetch("/api/auth/invite", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					token,
					...(preview.existingAccount
						? {}
						: { display_name: String(form.get("display_name") ?? "") }),
					password,
				}),
				signal: attempt.signal,
			});
			if (!isCurrent()) return;
			if (!response.ok) {
				const detail = await response.json().catch(() => null);
				if (!isCurrent()) return;
				const messages: Record<string, string> = {
					"invalid password": "原密码不正确，请重试",
					"local credentials required":
						"此账号不能使用本地密码接受邀请，请联系管理员",
					"user is disabled": "账号已停用，请联系管理员",
					"account is locked": "账号暂时锁定，请稍后重试",
					"invite is not pending": "邀请已使用或已撤销，请联系管理员",
					"invite expired": "邀请已过期，请联系管理员重新邀请",
					"user is already a member": "你已是此工作区成员，请登录",
					"password must be at least 7 characters": "密码至少需要 7 个字符",
					"password must contain uppercase and lowercase letters":
						"密码必须同时包含大写和小写字母",
					"password must be at most 256 characters": "密码最多允许 256 个字符",
				};
				setError(
					(typeof detail?.detail === "string" && messages[detail.detail]) ||
						"接受邀请失败，请稍后重试",
				);
				if (detail?.detail === "invalid password") {
					setPasswordError(true);
				}
				return;
			}
			const result = (await response.json()) as { session_created?: boolean };
			if (!isCurrent()) return;
			router.replace(result.session_created === false ? "/login" : "/app");
			router.refresh();
		} catch {
			if (isCurrent())
				setError("网络连接失败，请重试；若已加入工作区，可直接登录");
		} finally {
			if (isCurrent()) {
				submitAttempt.current = null;
				setSubmitting(false);
			}
		}
	}

	return (
		<div className="space-y-8">
			<div className="space-y-2">
				<h1 className="text-2xl font-semibold leading-8">接受邀请</h1>
				{preview ? (
					<p className="text-sm leading-6 text-muted-foreground">
						加入「{preview.workspaceName}」· 角色 {preview.role}
					</p>
				) : null}
			</div>
			{loadError ? (
				<p className="min-h-12 text-sm leading-6 text-destructive" role="alert">
					{loadError}
				</p>
			) : !preview ? (
				<p
					className="min-h-12 text-sm leading-6 text-muted-foreground"
					role="status"
				>
					加载邀请…
				</p>
			) : (
				<>
					<div className="space-y-1 border-y py-4">
						<p className="text-xs leading-5 text-muted-foreground">受邀邮箱</p>
						<p className="text-sm leading-6 break-all">{preview.email}</p>
					</div>
					<form
						method="post"
						className="space-y-5"
						onSubmit={submit}
						aria-busy={submitting}
					>
						{!preview.existingAccount ? (
							<div className="space-y-2">
								<Label htmlFor="display_name">显示名称</Label>
								<Input
									id="display_name"
									name="display_name"
									autoComplete="name"
									className="h-11 px-3 text-base md:text-base motion-reduce:transition-none"
									disabled={!token || submitting}
									defaultValue={preview.email.split("@")[0] ?? ""}
								/>
							</div>
						) : null}
						<div className="space-y-2">
							<Label htmlFor="password">
								{preview.existingAccount ? "原密码" : "设置密码"}
							</Label>
							<Input
								id="password"
								name="password"
								type="password"
								className="h-11 px-3 text-base md:text-base motion-reduce:transition-none"
								disabled={!token || submitting}
								aria-invalid={passwordError || undefined}
								aria-describedby={
									passwordError
										? "invite-password-hint invite-password-error"
										: "invite-password-hint"
								}
								autoComplete={
									preview.existingAccount ? "current-password" : "new-password"
								}
								minLength={preview.existingAccount ? undefined : 7}
								maxLength={preview.existingAccount ? undefined : 256}
								required
							/>
							<p
								id="invite-password-hint"
								className="text-xs leading-5 text-muted-foreground"
							>
								{preview.existingAccount
									? "该邮箱已有账号，请输入原密码。账号名称和密码不会更改。"
									: "7–256 个字符，并同时包含大写和小写字母。"}
							</p>
							<div className="min-h-6">
								{passwordError && error ? (
									<p
										id="invite-password-error"
										className="text-sm leading-6 text-destructive"
										role="alert"
									>
										{error}
									</p>
								) : null}
							</div>
						</div>
						<div className="min-h-6">
							{error && !passwordError ? (
								<p className="text-sm leading-6 text-destructive" role="alert">
									{error}
								</p>
							) : null}
						</div>
						<Button
							className="h-11 w-full"
							type="submit"
							disabled={!token || submitting}
						>
							{submitting ? "正在加入…" : "加入工作区"}
						</Button>
					</form>
				</>
			)}
			<div className="border-t pt-4">
				{submitting ? (
					<Button
						type="button"
						variant="link"
						className="min-h-11 px-0 text-muted-foreground"
						disabled
					>
						返回密码登录
					</Button>
				) : (
					<Link
						href="/login"
						className={buttonVariants({
							variant: "link",
							className:
								"min-h-11 px-0 text-muted-foreground hover:text-foreground",
						})}
					>
						返回密码登录
					</Link>
				)}
			</div>
		</div>
	);
}

export default function InvitePage() {
	return (
		<AuthPageShell>
			<Suspense
				fallback={
					<p
						className="min-h-80 text-sm leading-6 text-muted-foreground"
						role="status"
					>
						加载邀请…
					</p>
				}
			>
				<InviteForm />
			</Suspense>
		</AuthPageShell>
	);
}
