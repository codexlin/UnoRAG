"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { AuthPageShell } from "@/components/app/auth-page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function LoginFormPlaceholder() {
	return (
		<div role="status" aria-label="正在加载登录表单">
			<div aria-hidden className="space-y-5">
				{[0, 1].map((field) => (
					<div key={field} className="space-y-2">
						<div className="h-3.5 w-8 rounded-sm bg-muted" />
						<div className="h-11 rounded-lg border border-input" />
					</div>
				))}
				<div className="h-6" />
				<div className="h-11 rounded-lg bg-muted" />
			</div>
			<noscript>
				<p role="alert" className="mt-3 text-sm text-destructive">
					登录需要启用 JavaScript。
				</p>
			</noscript>
		</div>
	);
}

export default function LoginPage() {
	const router = useRouter();
	const [error, setError] = useState<string | null>(null);
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
						? "邮箱或密码不正确"
						: response.status === 429
							? "登录尝试过多，请稍后再试"
							: "登录服务暂时不可用",
				);
				return;
			}
			const identity = (await response.json()) as {
				mustChangePassword?: boolean;
			};
			router.replace(identity.mustChangePassword ? "/change-password" : "/app");
			router.refresh();
		} catch {
			setError("网络连接异常，请稍后重试");
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<AuthPageShell>
			<div className="space-y-2">
				<h1 className="text-2xl font-semibold leading-8">登录 UnoRAG</h1>
				<p className="text-sm leading-6 text-muted-foreground">
					使用你的工作区账号登录。
				</p>
			</div>
			{/* Password managers may insert sibling controls before hydration. */}
			{!ready ? (
				<LoginFormPlaceholder />
			) : (
				<form
					method="post"
					className="space-y-5"
					onSubmit={submit}
					aria-busy={submitting}
				>
					<div className="space-y-2">
						<Label htmlFor="email">邮箱</Label>
						<Input
							id="email"
							name="email"
							type="email"
							autoComplete="username"
							placeholder="admin@unorag.local"
							className="h-11 px-3 text-base md:text-base motion-reduce:transition-none"
							aria-invalid={error === "邮箱或密码不正确" || undefined}
							aria-describedby={error ? "login-error" : undefined}
							disabled={submitting}
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
							className="h-11 px-3 text-base md:text-base motion-reduce:transition-none"
							aria-invalid={error === "邮箱或密码不正确" || undefined}
							aria-describedby={error ? "login-error" : undefined}
							disabled={submitting}
							required
						/>
					</div>
					<div className="min-h-6">
						{error ? (
							<p
								id="login-error"
								className="text-sm leading-6 text-destructive"
								role="alert"
							>
								{error}
							</p>
						) : null}
					</div>
					<Button
						className="h-11 w-full"
						type="submit"
						disabled={!ready || submitting}
					>
						{submitting ? "正在登录..." : "登录"}
					</Button>
				</form>
			)}
			<nav
				aria-label="其他登录方式"
				className="flex flex-wrap justify-between gap-x-4 gap-y-2 border-t pt-4 text-sm"
			>
				<Link
					className="inline-flex min-h-11 items-center rounded-md text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
					href="/account-access?purpose=login"
				>
					使用邮箱链接登录
				</Link>
				<Link
					className="inline-flex min-h-11 items-center rounded-md text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
					href="/account-access?purpose=reset"
				>
					忘记密码
				</Link>
			</nav>
		</AuthPageShell>
	);
}
