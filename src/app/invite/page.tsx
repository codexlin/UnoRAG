"use client";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, Suspense, useEffect, useRef, useState } from "react";
import { AuthPageShell } from "@/components/app/auth-page-shell";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useInterfaceText } from "@/lib/i18n/provider";

type Preview = {
	email: string;
	role: string;
	workspaceName: string;
	expiresAt: string;
	status: string;
	existingAccount: boolean;
};

function InviteForm() {
	const t = useInterfaceText();
	const router = useRouter();
	const [token, setToken] = useState<string | null>(null);
	const initialized = useRef(false);
	const [preview, setPreview] = useState<Preview | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [passwordError, setPasswordError] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [redirectTarget, setRedirectTarget] = useState<
		"/app/ask" | "/login" | null
	>(null);
	const submitAttempt = useRef<AbortController | null>(null);
	const busy = submitting || Boolean(redirectTarget);

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
			setLoadError(t("缺少邀请链接", "Invitation link is missing."));
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
						response.status === 404
							? t(
									"邀请不存在或已失效",
									"The invitation was not found or is no longer valid.",
								)
							: t("无法加载邀请", "Couldn't load the invitation."),
					);
					return;
				}
				const data = (await response.json()) as Preview;
				if (controller.signal.aborted) return;
				if (data.status !== "pending") {
					setLoadError(
						data.status === "expired"
							? t(
									"邀请已过期，请联系管理员重新邀请",
									"The invitation has expired. Ask an administrator for a new link.",
								)
							: t(
									`邀请状态：${data.status}`,
									`Invitation status: ${data.status}`,
								),
					);
					return;
				}
				setPreview(data);
			} catch {
				if (!controller.signal.aborted)
					setLoadError(
						t(
							"网络连接失败，请重新打开邀请链接重试",
							"Couldn't connect. Reopen the invitation link and try again.",
						),
					);
			}
		})();
		return () => controller.abort();
	}, [token, t]);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!token || !preview || busy || submitAttempt.current) return;
		setSubmitting(true);
		setError(null);
		setPasswordError(false);
		let navigated = false;
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
			rejectPassword(
				t("密码需要 7–256 个字符", "Use 7–256 characters for your password."),
			);
			return;
		}
		if (
			!preview.existingAccount &&
			(!/[a-z]/.test(password) || !/[A-Z]/.test(password))
		) {
			rejectPassword(
				t(
					"密码必须同时包含大写和小写字母",
					"Use both uppercase and lowercase letters.",
				),
			);
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
					"invalid password": t(
						"原密码不正确，请重试",
						"Incorrect current password. Try again.",
					),
					"local credentials required": t(
						"此账号不能使用本地密码接受邀请，请联系管理员",
						"This account cannot accept an invitation with a local password. Contact your administrator.",
					),
					"user is disabled": t(
						"账号已停用，请联系管理员",
						"This account is disabled. Contact your administrator.",
					),
					"account is locked": t(
						"账号暂时锁定，请稍后重试",
						"This account is temporarily locked. Try again later.",
					),
					"invite is not pending": t(
						"邀请已使用或已撤销，请联系管理员",
						"This invitation was used or revoked. Contact your administrator.",
					),
					"invite expired": t(
						"邀请已过期，请联系管理员重新邀请",
						"The invitation has expired. Ask an administrator for a new link.",
					),
					"user is already a member": t(
						"你已是此工作区成员，请登录",
						"You already belong to this workspace. Please sign in.",
					),
					"password must be at least 7 characters": t(
						"密码至少需要 7 个字符",
						"Use at least 7 characters.",
					),
					"password must contain uppercase and lowercase letters": t(
						"密码必须同时包含大写和小写字母",
						"Use both uppercase and lowercase letters.",
					),
					"password must be at most 256 characters": t(
						"密码最多允许 256 个字符",
						"Use at most 256 characters.",
					),
				};
				setError(
					(typeof detail?.detail === "string" && messages[detail.detail]) ||
						t(
							"接受邀请失败，请稍后重试",
							"Couldn't accept the invitation. Try again later.",
						),
				);
				if (detail?.detail === "invalid password") {
					setPasswordError(true);
				}
				return;
			}
			const result = (await response.json()) as { session_created?: boolean };
			if (!isCurrent()) return;
			const target = result.session_created === false ? "/login" : "/app/ask";
			navigated = true;
			setRedirectTarget(target);
			window.location.replace(target);
		} catch {
			if (isCurrent())
				setError(
					t(
						"网络连接失败，请重试；若已加入工作区，可直接登录",
						"Couldn't connect. Try again, or sign in if you already joined.",
					),
				);
		} finally {
			if (isCurrent() && !navigated) {
				submitAttempt.current = null;
				setSubmitting(false);
			}
		}
	}

	return (
		<div className="space-y-8">
			<div className="space-y-2">
				<h1 className="text-2xl font-semibold leading-8">
					{t("接受邀请", "Accept invitation")}
				</h1>
				{preview ? (
					<p className="text-sm leading-6 text-muted-foreground">
						{t(
							`加入「${preview.workspaceName}」· 角色 ${preview.role}`,
							`Join ${preview.workspaceName} · Role: ${preview.role}`,
						)}
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
					{t("加载邀请…", "Loading invitation…")}
				</p>
			) : (
				<>
					<div className="space-y-1 border-y py-4">
						<p className="text-xs leading-5 text-muted-foreground">
							{t("受邀邮箱", "Invited email")}
						</p>
						<p className="text-sm leading-6 break-all">{preview.email}</p>
					</div>
					<form
						method="post"
						className="space-y-5"
						onSubmit={submit}
						aria-busy={busy}
					>
						{!preview.existingAccount ? (
							<div className="space-y-2">
								<Label htmlFor="display_name">
									{t("显示名称", "Display name")}
								</Label>
								<Input
									id="display_name"
									name="display_name"
									autoComplete="name"
									className="h-11 px-3 text-base md:text-base motion-reduce:transition-none"
									disabled={!token || busy}
									defaultValue={preview.email.split("@")[0] ?? ""}
								/>
							</div>
						) : null}
						<div className="space-y-2">
							<Label htmlFor="password">
								{preview.existingAccount
									? t("原密码", "Current password")
									: t("设置密码", "Choose password")}
							</Label>
							<Input
								id="password"
								name="password"
								type="password"
								className="h-11 px-3 text-base md:text-base motion-reduce:transition-none"
								disabled={!token || busy}
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
									? t(
											"该邮箱已有账号，请输入原密码。账号名称和密码不会更改。",
											"An account already uses this email. Enter its current password. The account name and password will not change.",
										)
									: t(
											"7–256 个字符，并同时包含大写和小写字母。",
											"Use 7–256 characters, with uppercase and lowercase letters.",
										)}
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
							disabled={!token || busy}
						>
							{busy ? (
								<>
									<Loader2
										className="size-4 animate-spin motion-reduce:hidden"
										aria-hidden
									/>
									{redirectTarget === "/app/ask"
										? t("正在进入工作区…", "Entering workspace…")
										: redirectTarget === "/login"
											? t("正在前往登录…", "Opening sign-in…")
											: t("正在加入…", "Joining…")}
								</>
							) : (
								t("加入工作区", "Join workspace")
							)}
						</Button>
					</form>
				</>
			)}
			<div className="border-t pt-4">
				{busy ? (
					<Button
						type="button"
						variant="link"
						className="min-h-11 px-0 text-muted-foreground"
						disabled
					>
						{t("返回密码登录", "Back to password sign-in")}
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
						{t("返回密码登录", "Back to password sign-in")}
					</Link>
				)}
			</div>
		</div>
	);
}

export default function InvitePage() {
	const t = useInterfaceText();
	return (
		<AuthPageShell>
			<Suspense
				fallback={
					<p
						className="min-h-80 text-sm leading-6 text-muted-foreground"
						role="status"
					>
						{t("加载邀请…", "Loading invitation…")}
					</p>
				}
			>
				<InviteForm />
			</Suspense>
		</AuthPageShell>
	);
}
