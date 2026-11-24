"use client";

import { ChevronDown, RefreshCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { healthRecovery } from "@/components/app/settings/health-recovery";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useHealth } from "@/hooks/use-health";
import { getApiBaseUrl } from "@/lib/api";
import { formatDateTime, formatDurationMs } from "@/lib/format";
import { useInterfaceLanguage, useInterfaceText } from "@/lib/i18n/provider";
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
	const t = useInterfaceText();
	const { locale } = useInterfaceLanguage();
	const { health, error, loading, healthProbedAt, healthProbeMs, refresh } =
		useHealth();
	const [refreshing, setRefreshing] = useState(false);
	const recovery = health && healthRecovery(health, locale);
	return (
		<section
			id="service"
			aria-labelledby="settings-health-heading"
			className="min-w-0 space-y-6 text-sm"
		>
			<header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 pb-3">
				<h3 id="settings-health-heading" className="text-base font-medium">
					{t("服务状态", "Service status")}
				</h3>
				<Button
					type="button"
					variant="outline"
					className="h-11 md:h-9"
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
					{refreshing
						? t("探测中…", "Checking…")
						: t("重新探测", "Check again")}
				</Button>
			</header>
			{error ? (
				<p role="alert" className="text-warning-foreground">
					{health
						? t(
								"最近探测失败，以下为上次成功快照；当前就绪状态未知。",
								"The latest health check failed. Showing the last successful snapshot; current readiness is unknown.",
							)
						: t("无法连接 API", "Unable to reach the API")}
				</p>
			) : null}
			{health ? (
				<>
					<dl className="grid min-w-0 gap-x-8 md:grid-cols-2">
						<StatusField label={t("版本", "Version")}>
							<span className="font-mono">
								{formatReleaseVersion(health.release)}
							</span>
						</StatusField>
						<StatusField label={t("状态", "Status")}>
							{error
								? t("未知（探测失败）", "Unknown (check failed)")
								: health.degraded || health.status !== "ok"
									? t("不可用", "Unavailable")
									: t("正常", "Healthy")}
						</StatusField>
						<StatusField label={t("Ask 就绪", "Ask ready")}>
							{error || health.ask_ready == null
								? t("未知", "Unknown")
								: health.ask_ready
									? t("是", "Yes")
									: t("否", "No")}
						</StatusField>
						<StatusField label="Qdrant">
							{error
								? t("未知", "Unknown")
								: health.qdrant_ok
									? t("可达", "Reachable")
									: t("不可达", "Unreachable")}
						</StatusField>
						<StatusField label={t("元数据", "Metadata")}>
							{health.metadata_backend}
							{error
								? t(" · 当前状态未知", " · Status unknown")
								: health.metadata_ok === false
									? t(" · 异常", " · Unhealthy")
									: ""}
						</StatusField>
						<StatusField label={t("最近探测", "Last checked")}>
							{formatDateTime(healthProbedAt)}
							{healthProbeMs != null
								? ` · ${formatDurationMs(healthProbeMs)}`
								: ""}
						</StatusField>
					</dl>
					{health.reasons.length > 0 ? (
						<p className="break-words text-destructive">
							{health.reasons.join(t("，", ", "))}
						</p>
					) : null}
					{recovery ? (
						<div className="space-y-1 rounded-lg border border-warning-foreground/25 bg-warning px-4 py-3 text-warning-foreground [overflow-wrap:anywhere]">
							<h4 className="font-medium">
								{t("恢复建议", "Recovery guidance")}
							</h4>
							<p>{recovery}</p>
						</div>
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
							{t("技术信息", "Technical details")}
							<ChevronDown
								className="size-4 transition-transform group-data-open:rotate-180 motion-reduce:transition-none"
								aria-hidden
							/>
						</CollapsibleTrigger>
						<CollapsibleContent>
							<dl className="min-w-0 pb-2">
								<StatusField label={t("API 地址", "API URL")}>
									<span className="font-mono text-xs">{getApiBaseUrl()}</span>
								</StatusField>
								<StatusField label={t("提交", "Commit")}>
									<span className="font-mono">
										{health.release.revision_short}
									</span>
								</StatusField>
								<StatusField label={t("构建时间", "Built at")}>
									{health.release.built_at
										? formatDateTime(Date.parse(health.release.built_at))
										: t("本地开发", "Local development")}
								</StatusField>
								<StatusField label={t("请求模式", "Requested mode")}>
									{health.ask_mode}
								</StatusField>
								<StatusField label={t("生效模式", "Effective mode")}>
									{health.effective_mode}
									{health.ask_mode === "stub"
										? t(" · 测试/本地", " · Test/local")
										: ""}
								</StatusField>
								<StatusField label={t("执行图", "Execution graph")}>
									{health.graph}
								</StatusField>
								<StatusField label={t("LLM 密钥", "LLM key")}>
									{health.has_llm_key
										? t("已配置", "Configured")
										: t("未配置", "Not configured")}
								</StatusField>
								<StatusField
									label={t(
										"全局默认混合检索",
										"Global hybrid retrieval default",
									)}
								>
									{health.hybrid_enabled == null
										? t("未提供", "Not provided")
										: health.hybrid_enabled
											? t("默认开启", "Enabled by default")
											: t(
													"默认关闭（自动策略可按问法开启）",
													"Disabled by default (Auto policy can enable per query)",
												)}
								</StatusField>
							</dl>
						</CollapsibleContent>
					</Collapsible>
				</>
			) : !error ? (
				<p role="status" className="text-muted-foreground">
					{loading ? t("探测中…", "Checking…") : t("暂无数据", "No data")}
				</p>
			) : null}
		</section>
	);
}
