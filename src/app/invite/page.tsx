"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useEffect, useState } from "react";

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
};

function InviteForm() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const token = searchParams.get("token")?.trim() ?? "";
	const [preview, setPreview] = useState<Preview | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	useEffect(() => {
		if (!token) {
			setLoadError("缺少邀请链接");
			return;
		}
		let cancelled = false;
		(async () => {
			const response = await fetch(
				`/api/auth/invite?token=${encodeURIComponent(token)}`,
			);
			if (cancelled) return;
			if (!response.ok) {
				setLoadError(
					response.status === 404 ? "邀请不存在或已失效" : "无法加载邀请",
				);
				return;
			}
			const data = (await response.json()) as Preview;
			if (data.status !== "pending") {
				setLoadError(
					data.status === "expired"
						? "邀请已过期，请联系管理员重新邀请"
						: `邀请状态：${data.status}`,
				);
				return;
			}
			setPreview(data);
		})();
		return () => {
			cancelled = true;
		};
	}, [token]);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!token) return;
		setSubmitting(true);
		setError(null);
		const form = new FormData(event.currentTarget);
		const password = String(form.get("password") ?? "");
		if (password.length < 7) {
			setError("密码至少需要 7 个字符");
			setSubmitting(false);
			return;
		}
		if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
			setError("密码必须同时包含大写和小写字母");
			setSubmitting(false);
			return;
		}
		const response = await fetch("/api/auth/invite", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				token,
				display_name: form.get("display_name"),
				password,
			}),
		});
		if (!response.ok) {
			const detail = await response.json().catch(() => null);
			const messages: Record<string, string> = {
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
		router.replace("/app");
		router.refresh();
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
							<div className="space-y-2">
								<Label htmlFor="display_name">显示名称</Label>
								<Input
									id="display_name"
									name="display_name"
									autoComplete="name"
									defaultValue={preview.email.split("@")[0] ?? ""}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="password">设置密码</Label>
								<Input
									id="password"
									name="password"
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
