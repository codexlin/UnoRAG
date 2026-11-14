"use client";

import { ChevronDown, RefreshCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useHealth } from "@/hooks/use-health";
import { getApiBaseUrl } from "@/lib/api";
import { formatDateTime, formatDurationMs } from "@/lib/format";
import { formatReleaseVersion } from "@/lib/release-info";

function StatusField({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border/60 py-3">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="min-w-0 break-all text-right">{children}</dd>
		</div>
	);
}

export function WorkspaceServicePanel() {
	const { health, error, loading, healthProbedAt, healthProbeMs, refresh } =
		useHealth();
	const [refreshing, setRefreshing] = useState(false);
	return (
		<section
			id="service"
			aria-labelledby="settings-health-heading"
			className="min-w-0 space-y-6 text-sm"
		>
			<header className="flex flex-wrap items-center justify-between gap-3">
				<h3 id="settings-health-heading" className="text-xl font-medium">
					服务状态
				</h3>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="h-11"
					disabled={refreshing || loading}
					onClick={async () => {
						setRefreshing(true);
						try {
							await refresh();
						} catch {
							/* The query exposes the probe error below. */
						} finally {
							setRefreshing(false);
						}
					}}
				>
					<RefreshCw className="size-4" aria-hidden />
					{refreshing ? "探测中…" : "重新探测"}
				</Button>
			</header>
			{error ? (
				<p role="alert" className="text-warning-foreground">
					{health
						? "最近探测失败，以下为上次成功快照；当前就绪状态未知。"
						: "无法连接 API"}
				</p>
			) : null}
			{health ? (
				<>
					<dl className="grid min-w-0 gap-x-8 md:grid-cols-2">
						<StatusField label="版本">
							<span className="font-mono">
								{formatReleaseVersion(health.release)}
							</span>
						</StatusField>
						<StatusField label="状态">
							{error
								? "未知（探测失败）"
								: health.degraded || health.status !== "ok"
									? "不可用"
									: "正常"}
						</StatusField>
						<StatusField label="Ask 就绪">
							{error || health.ask_ready == null
								? "未知"
								: health.ask_ready
									? "是"
									: "否"}
						</StatusField>
						<StatusField label="Qdrant">
							{error ? "未知" : health.qdrant_ok ? "可达" : "不可达"}
						</StatusField>
						<StatusField label="元数据">
							{health.metadata_backend}
							{error
								? " · 当前状态未知"
								: health.metadata_ok === false
									? " · 异常"
									: ""}
						</StatusField>
						<StatusField label="最近探测">
							{formatDateTime(healthProbedAt)}
							{healthProbeMs != null
								? ` · ${formatDurationMs(healthProbeMs)}`
								: ""}
						</StatusField>
					</dl>
					{health.reasons.length > 0 ? (
						<p className="break-words text-destructive">
							{health.reasons.join("，")}
						</p>
					) : null}
					<Collapsible className="min-w-0 border-t border-border pt-2">
						<CollapsibleTrigger
							render={
								<Button
									variant="ghost"
									className="group min-h-11 h-auto w-full justify-between px-0 text-sm"
								/>
							}
						>
							技术信息
							<ChevronDown
								className="size-4 transition-transform group-data-open:rotate-180 motion-reduce:transition-none"
								aria-hidden
							/>
						</CollapsibleTrigger>
						<CollapsibleContent>
							<dl className="min-w-0 pb-2">
								<StatusField label="API 地址">
									<span className="font-mono text-xs">{getApiBaseUrl()}</span>
								</StatusField>
								<StatusField label="提交">
									<span className="font-mono">
										{health.release.revision_short}
									</span>
								</StatusField>
								<StatusField label="构建时间">
									{health.release.built_at
										? formatDateTime(Date.parse(health.release.built_at))
										: "本地开发"}
								</StatusField>
								<StatusField label="请求模式">{health.ask_mode}</StatusField>
								<StatusField label="生效模式">
									{health.effective_mode}
									{health.ask_mode === "stub" ? " · 测试/本地" : ""}
								</StatusField>
								<StatusField label="执行图">{health.graph}</StatusField>
								<StatusField label="LLM 密钥">
									{health.has_llm_key ? "已配置" : "未配置"}
								</StatusField>
								<StatusField label="全局默认混合检索">
									{health.hybrid_enabled == null
										? "未提供"
										: health.hybrid_enabled
											? "默认开启"
											: "默认关闭（自动策略可按问法开启）"}
								</StatusField>
							</dl>
						</CollapsibleContent>
					</Collapsible>
				</>
			) : !error ? (
				<p role="status" className="text-muted-foreground">
					{loading ? "探测中…" : "暂无数据"}
				</p>
			) : null}
		</section>
	);
}
