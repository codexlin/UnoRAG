"use client";

import { WorkspaceAskSettingsPanel } from "@/components/app/workspace-ask-settings-panel";
import { WorkspaceMembersPanel } from "@/components/app/workspace-members-panel";
import { useHealth } from "@/hooks/use-health";
import { getApiBaseUrl } from "@/lib/api";
import { formatDateTime, formatDurationMs } from "@/lib/format";
import { cn } from "@/lib/utils";

export default function SettingsPage() {
	const { health, error, loading, healthProbedAt, healthProbeMs } = useHealth();

	return (
		<div className="flex flex-1 flex-col px-5 py-8 sm:px-6 lg:px-8 lg:py-10">
			<div className="mx-auto w-full max-w-6xl space-y-8">
				<div className="max-w-3xl space-y-2">
					<p className="text-meta font-mono tracking-[0.2em] text-cite uppercase">
						Settings
					</p>
					<h2 className="font-heading text-2xl font-semibold tracking-tight">
						工作区设置
					</h2>
					<p className="text-answer text-muted-foreground">
						问答与检索可在下方按工作区覆盖；未覆盖 = 代码默认。生产默认走
						live；若 live
						未就绪，健康检查会标为不可用并拒绝问答，不会静默降级到 stub。stub
						仅用于本地/测试显式配置。
					</p>
				</div>

				<div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-8">
					<WorkspaceAskSettingsPanel />

					<div className="space-y-6">
						<WorkspaceMembersPanel />

						<div className="rounded-2xl border border-border/80 bg-card/80 px-4 py-4">
							<p className="text-meta font-mono tracking-[0.16em] text-muted-foreground uppercase">
								API
							</p>
							<p className="text-ui mt-1 font-mono text-muted-foreground">
								{getApiBaseUrl()}
							</p>
							{error && !health ? (
								<p className="text-ui mt-3 text-destructive">无法连接 API</p>
							) : health ? (
								<ul className="text-ui mt-4 space-y-2.5 text-foreground">
									<li className="flex justify-between gap-3">
										<span className="text-muted-foreground">请求模式</span>
										<span className="font-mono text-[0.8125rem]">
											{health.ask_mode}
										</span>
									</li>
									<li className="flex justify-between gap-3">
										<span className="text-muted-foreground">状态</span>
										<span
											className={cn(
												"font-mono text-[0.8125rem]",
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
										<span className="font-mono text-[0.8125rem]">
											{health.effective_mode}
											{health.ask_mode === "stub" ? " · 测试/本地" : ""}
										</span>
									</li>
									<li className="flex justify-between gap-3">
										<span className="text-muted-foreground">Ask 就绪</span>
										<span className="font-mono text-[0.8125rem]">
											{health.ask_ready === false ? "否" : "是"}
										</span>
									</li>
									<li className="flex justify-between gap-3">
										<span className="text-muted-foreground">图</span>
										<span className="font-mono text-[0.8125rem]">
											{health.graph}
										</span>
									</li>
									<li className="flex justify-between gap-3">
										<span className="text-muted-foreground">LLM 密钥</span>
										<span className="font-mono text-[0.8125rem]">
											{health.has_llm_key ? "已配置" : "未配置"}
										</span>
									</li>
									<li className="flex justify-between gap-3">
										<span className="text-muted-foreground">Qdrant</span>
										<span className="font-mono text-[0.8125rem]">
											{health.qdrant_ok ? "可达" : "不可达"}
										</span>
									</li>
									<li className="flex justify-between gap-3">
										<span className="text-muted-foreground">混合检索</span>
										<span className="font-mono text-[0.8125rem]">
											{health.hybrid_enabled ? "开启" : "关闭"}
										</span>
									</li>
									<li className="flex justify-between gap-3">
										<span className="text-muted-foreground">元数据</span>
										<span className="font-mono text-[0.8125rem]">
											{health.metadata_backend}
											{health.metadata_ok === false ? " · 异常" : ""}
										</span>
									</li>
									<li className="flex justify-between gap-3">
										<span className="text-muted-foreground">最近探测</span>
										<span className="text-right font-mono text-[0.8125rem]">
											{formatDateTime(healthProbedAt)}
											{healthProbeMs != null
												? ` · ${formatDurationMs(healthProbeMs)}`
												: ""}
										</span>
									</li>
									{health.reasons.length > 0 ? (
										<li className="flex justify-between gap-3">
											<span className="text-muted-foreground">原因</span>
											<span className="max-w-[60%] text-right font-mono text-[0.8125rem] text-muted-foreground">
												{health.reasons.join(", ")}
											</span>
										</li>
									) : null}
								</ul>
							) : (
								<p className="text-ui mt-3 text-muted-foreground">
									{loading ? "探测中…" : "暂无数据"}
								</p>
							)}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
