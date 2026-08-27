"use client";

import { KeyRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { UnoRAGLogo } from "@/components/app/unorag-logo";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export function LoginForm({
	localEnabled,
	oidcEnabled,
	oidcLabel,
	initialError,
}: Readonly<{
	localEnabled: boolean;
	oidcEnabled: boolean;
	oidcLabel: string;
	initialError?: string;
}>) {
	const router = useRouter();
	const [error, setError] = useState<string | null>(initialError ?? null);
	const [submitting, setSubmitting] = useState(false);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setSubmitting(true);
		setError(null);
		const form = new FormData(event.currentTarget);
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
				response.status === 401 ? "邮箱或密码不正确" : "登录服务暂时不可用",
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
				{oidcEnabled ? (
					<Link
						href="/api/auth/oidc/start"
						className={cn(buttonVariants({ size: "lg" }), "w-full")}
					>
						<KeyRound />
						{oidcLabel}
					</Link>
				) : null}
				{oidcEnabled && localEnabled ? (
					<div className="my-6 flex items-center gap-3 text-xs text-muted-foreground">
						<span className="h-px flex-1 bg-border" />
						本地管理员应急登录
						<span className="h-px flex-1 bg-border" />
					</div>
				) : null}
				{localEnabled ? (
					<form className="space-y-5" onSubmit={submit}>
						<div className="space-y-2">
							<Label htmlFor="email">邮箱</Label>
							<Input
								id="email"
								name="email"
								type="email"
								autoComplete="username"
								required
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="password">密码</Label>
							<Input
								id="password"
								name="password"
								type="password"
								autoComplete="current-password"
								required
							/>
						</div>
						<Button className="w-full" type="submit" disabled={submitting}>
							{submitting ? "正在登录..." : "登录"}
						</Button>
					</form>
				) : null}
				{error ? (
					<p className="mt-5 text-sm text-destructive" role="alert">
						{error}
					</p>
				) : null}
				{!localEnabled && !oidcEnabled ? (
					<p className="text-sm text-destructive" role="alert">
						未配置可用的登录方式，请联系部署管理员。
					</p>
				) : null}
			</div>
		</main>
	);
}
