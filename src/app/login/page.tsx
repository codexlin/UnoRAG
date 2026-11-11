"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { UnoRAGLogo } from "@/components/app/unorag-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
	const router = useRouter();
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (submitting) return;
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
		<main className="grid min-h-dvh place-items-center bg-background px-6 py-10">
			<div className="w-full max-w-sm">
				<div className="mb-8 flex items-center gap-3">
					<UnoRAGLogo size="md" withWordmark />
				</div>
				<form className="space-y-5" onSubmit={submit}>
					<div className="space-y-2">
						<Label htmlFor="email">邮箱</Label>
						<Input
							id="email"
							name="email"
							type="email"
							autoComplete="username"
							placeholder="admin@unorag.local"
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
					{error ? (
						<p className="text-sm text-destructive" role="alert">
							{error}
						</p>
					) : null}
					<Button className="w-full" type="submit" disabled={submitting}>
						{submitting ? "正在登录..." : "登录"}
					</Button>
				</form>
				<nav
					aria-label="其他登录方式"
					className="mt-5 flex flex-wrap justify-between gap-2 text-sm"
				>
					<Link
						className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline"
						href="/account-access?purpose=login"
					>
						使用邮箱链接登录
					</Link>
					<Link
						className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline"
						href="/account-access?purpose=reset"
					>
						忘记密码
					</Link>
				</nav>
			</div>
		</main>
	);
}
