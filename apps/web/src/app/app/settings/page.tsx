"use client";

import { useHealth } from "@/hooks/use-health";
import { getApiBaseUrl } from "@/lib/api";
import { cn } from "@/lib/utils";

export default function SettingsPage() {
	const { health, error, loading } = useHealth();

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
						模型与检索参数由 API 环境变量配置。生产默认走 live；若 live
						未就绪，健康检查会标为不可用并拒绝问答，不会静默降级到 stub。stub
						仅用于本地/测试显式配置。
					</p>
				</div>

				<div className="rounded-md border border-border/80 bg-card/80 px-4 py-4">
					<p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
						API
					</p>
					<p className="mt-1 font-mono text-xs text-muted-foreground">
						{getApiBaseUrl()}
					</p>
					{error && !health ? (
						<p className="mt-3 text-sm text-destructive">无法连接 API</p>
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
									{health.ask_mode === "stub" ? " · 测试/本地" : ""}
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
						<p className="mt-3 text-sm text-muted-foreground">
							{loading ? "探测中…" : "暂无数据"}
						</p>
					)}
				</div>
			</div>
		</div>
	);
}
