"use client";

import { useEffect, useState } from "react";

import {
	type ApiHealth,
	fetchHealth,
	getApiBaseUrl,
	isAbortError,
} from "@/lib/api";
import { cn } from "@/lib/utils";

export default function SettingsPage() {
	const [health, setHealth] = useState<ApiHealth | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		void fetchHealth(controller.signal)
			.then((payload) => {
				if (controller.signal.aborted) return;
				setHealth(payload);
				setError(null);
			})
			.catch((err) => {
				if (controller.signal.aborted || isAbortError(err)) return;
				setHealth(null);
				setError("无法连接 API");
			});
		return () => controller.abort();
	}, []);

	return (
		<div className="flex flex-1 items-start justify-center px-5 py-12">
			<div className="w-full max-w-lg space-y-6">
				<div className="space-y-2 text-center sm:text-left">
					<p className="font-mono text-xs tracking-[0.2em] text-cite uppercase">
						Settings
					</p>
					<h2 className="font-heading text-2xl font-semibold tracking-tight">
						工作区设置
					</h2>
					<p className="text-sm leading-6 text-muted-foreground">
						模型与检索阈值由 API 环境变量配置。此处展示当前服务健康与 live /
						stub 状态。
					</p>
				</div>

				<div className="rounded-md border border-border/80 bg-card/80 px-4 py-4">
					<p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
						API
					</p>
					<p className="mt-1 font-mono text-xs text-muted-foreground">
						{getApiBaseUrl()}
					</p>
					{error ? (
						<p className="mt-3 text-sm text-destructive">{error}</p>
					) : health ? (
						<ul className="mt-4 space-y-2 text-sm text-foreground">
							<li className="flex justify-between gap-3">
								<span className="text-muted-foreground">请求模式</span>
								<span className="font-mono text-xs">{health.ask_mode}</span>
							</li>
							<li className="flex justify-between gap-3">
								<span className="text-muted-foreground">状态</span>
								<span
									className={cn(
										"font-mono text-xs",
										(health.degraded || health.status !== "ok") &&
											"text-destructive",
									)}
								>
									{health.status}
									{health.degraded ? "（不可用）" : ""}
								</span>
							</li>
							<li className="flex justify-between gap-3">
								<span className="text-muted-foreground">生效模式</span>
								<span className="font-mono text-xs">
									{health.effective_mode}
								</span>
							</li>
							<li className="flex justify-between gap-3">
								<span className="text-muted-foreground">Ask 就绪</span>
								<span className="font-mono text-xs">
									{health.ask_ready === false ? "否" : "是"}
								</span>
							</li>
							<li className="flex justify-between gap-3">
								<span className="text-muted-foreground">图</span>
								<span className="font-mono text-xs">{health.graph}</span>
							</li>
							<li className="flex justify-between gap-3">
								<span className="text-muted-foreground">LLM 密钥</span>
								<span className="font-mono text-xs">
									{health.has_llm_key ? "已配置" : "未配置"}
								</span>
							</li>
							<li className="flex justify-between gap-3">
								<span className="text-muted-foreground">Qdrant</span>
								<span className="font-mono text-xs">
									{health.qdrant_ok ? "可达" : "不可达"}
								</span>
							</li>
							{health.reasons.length > 0 ? (
								<li className="flex justify-between gap-3">
									<span className="text-muted-foreground">原因</span>
									<span className="max-w-[60%] text-right font-mono text-xs text-muted-foreground">
										{health.reasons.join(", ")}
									</span>
								</li>
							) : null}
						</ul>
					) : (
						<p className="mt-3 text-sm text-muted-foreground">探测中…</p>
					)}
				</div>
			</div>
		</div>
	);
}
