"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, Suspense, useEffect, useRef, useState } from "react";

import { UnoRAGLogo } from "@/components/app/unorag-logo";
import { Button } from "@/components/ui/button";
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
	const [submitting, setSubmitting] = useState(false);

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
		let cancelled = false;
		(async () => {
			try {
				const response = await fetch("/api/auth/invite/preview", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ token }),
				});
				if (cancelled) return;
				if (!response.ok) {
					setLoadError(
						response.status === 404 ? "邀请不存在或已失效" : "无法加载邀请",
					);
					return;
				}
				const data = (await response.json()) as Preview;
				if (cancelled) return;
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
				if (!cancelled) setLoadError("网络连接失败，请重新打开邀请链接重试");
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [token]);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!token || !preview || submitting) return;
		setSubmitting(true);
		setError(null);
		const form = new FormData(event.currentTarget);
		const password = String(form.get("password") ?? "");
		if (
			!preview.existingAccount &&
			(password.length < 7 || password.length > 256)
		) {
			setError("密码需要 7–256 个字符");
			setSubmitting(false);
			return;
		}
		if (
			!preview.existingAccount &&
			(!/[a-z]/.test(password) || !/[A-Z]/.test(password))
		) {
			setError("密码必须同时包含大写和小写字母");
			setSubmitting(false);
			return;
		}
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
			});
			if (!response.ok) {
				const detail = await response.json().catch(() => null);
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
				setSubmitting(false);
				return;
			}
			const result = (await response.json()) as { session_created?: boolean };
			router.replace(result.session_created === false ? "/login" : "/app");
			router.refresh();
		} catch {
			setError("网络连接失败，请重试；若已加入工作区，可直接登录");
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<main className="grid min-h-dvh place-items-center bg-background px-6">
			<div className="w-full max-w-sm">
				<div className="mb-8 flex items-center gap-3">
					<UnoRAGLogo size="md" withWordmark />
				</div>
				{loadError ? (
					<p className="text-sm text-destructive" role="alert">
						{loadError}
					</p>
				) : !preview ? (
					<p className="text-sm text-muted-foreground">加载邀请…</p>
				) : (
					<>
						<div className="mb-6 space-y-1">
							<h1 className="font-heading text-xl font-semibold tracking-tight">
								接受邀请
							</h1>
							<p className="text-sm text-muted-foreground">
								加入「{preview.workspaceName}」· 角色 {preview.role}
							</p>
							<p className="font-mono text-xs text-muted-foreground">
								{preview.email}
							</p>
						</div>
						<form className="space-y-5" onSubmit={submit}>
							{!preview.existingAccount ? (
								<div className="space-y-2">
									<Label htmlFor="display_name">显示名称</Label>
									<Input
										id="display_name"
										name="display_name"
										autoComplete="name"
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
									autoComplete={
										preview.existingAccount
											? "current-password"
											: "new-password"
									}
									minLength={preview.existingAccount ? undefined : 7}
									maxLength={preview.existingAccount ? undefined : 256}
									required
								/>
								<p className="text-xs text-muted-foreground">
									{preview.existingAccount
										? "该邮箱已有账号，请输入原密码。账号名称和密码不会更改。"
										: "7–256 个字符，并同时包含大写和小写字母。"}
								</p>
							</div>
							{error ? (
								<p className="text-sm text-destructive" role="alert">
									{error}
								</p>
							) : null}
							<Button className="w-full" type="submit" disabled={submitting}>
								{submitting ? "正在加入…" : "加入工作区"}
							</Button>
						</form>
					</>
				)}
			</div>
		</main>
	);
}

export default function InvitePage() {
	return (
		<Suspense
			fallback={
				<main className="grid min-h-dvh place-items-center px-6 text-sm text-muted-foreground">
					加载邀请…
				</main>
			}
		>
			<InviteForm />
		</Suspense>
	);
}
