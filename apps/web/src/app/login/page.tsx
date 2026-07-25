"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { MeriKnowLogo } from "@/components/app/meriknow-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
	const router = useRouter();
	const [error, setError] = useState<string | null>(null);
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
					<MeriKnowLogo size="md" withWordmark />
				</div>
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
					{error ? (
						<p className="text-sm text-destructive" role="alert">
							{error}
						</p>
					) : null}
					<Button className="w-full" type="submit" disabled={submitting}>
						{submitting ? "正在登录..." : "登录"}
					</Button>
				</form>
			</div>
		</main>
	);
}
