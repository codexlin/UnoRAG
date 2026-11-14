"use client";

import {
	AlertTriangle,
	Ban,
	BellRing,
	CheckCircle2,
	ChevronDown,
	Clock3,
	Database,
	RefreshCw,
	ShieldAlert,
	TimerReset,
} from "lucide-react";
import Link from "next/link";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";

import { useCan } from "@/components/app/can";
import {
	OperationsErrorDrawer,
	type OperationsErrorRef,
} from "@/components/app/operations-error-drawer";
import { OperationsRequestsPanel } from "@/components/app/operations-requests-panel";
import { useSession } from "@/components/app/session-provider";
import { stageDisplayName } from "@/components/app/stage-waterfall";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { formatDateTime, formatDurationMs } from "@/lib/format";
import { formatReleaseVersion, type ReleaseInfo } from "@/lib/release-info";
import { cn } from "@/lib/utils";

type AlertSeverity = "critical" | "warning" | "info";
type OperationsAlert = {
	id: string;
	code: string;
	severity: AlertSeverity;
	status: "active" | "resolved";
	title: string;
	detail: string;
	recovery: string;
	first_triggered_at: string;
	last_observed_at: string;
	resolved_at: string | null;
	occurrence_count: number;
	last_delivery_status: string | null;
	last_delivery_at: string | null;
};

type OperationsSnapshot = {
	release: ReleaseInfo;
	scope: { workspace_id: string };
	overall: {
		status: "healthy" | "degraded" | "unavailable" | "unknown";
		evaluated_at: string;
		stale: boolean;
	};
	notifications: { webhook: boolean; email: boolean };
	generated_at: string;
	window: {
		from: string;
		to: string;
		hours: number;
		stuck_after_minutes: number;
	};
	ask: {
		total: number;
		completed: number;
		refused: number;
		failed: number;
		cancelled: number;
		running: number;
		latency_ms: { p50: number | null; p95: number | null };
		stage_latency_ms: StageLatency[];
		without_citations: number;
	};
	jobs: {
		queued: number;
		running: number;
		delete_failed: number;
		dead: number;
		stuck: number;
		oldest_active: {
			id: string;
			type: string;
			status: string;
			stage: string;
			age_ms: number;
			created_at: string;
		} | null;
		stage_latency_ms: StageLatency[];
	};
	components: Array<{
		code: string;
		label: string;
		kind: "infrastructure" | "ai" | "parser";
		status: "healthy" | "degraded" | "disabled" | "unknown";
		mode: "active" | "configuration";
		latency_ms: number | null;
		error_code: string | null;
		recovery: string;
		checked_at: string;
		last_success_at: string | null;
		stale: boolean;
	}>;
	alerts: OperationsAlert[];
	recent_errors: Array<{
		id: string;
		resource_id: string;
		source: "ask" | "job";
		status: string;
		error_code: string;
		occurred_at: string;
		job_type: string | null;
		stage: string | null;
		attempt: number | null;
	}>;
};

type StageLatency = {
	stage: string;
	count: number;
	failed: number;
	p50: number | null;
	p95: number | null;
};

function percent(value: number): string {
	return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function latency(value: number | null): string {
	return value == null ? "--" : formatDurationMs(value);
}

function MetricCell({
	label,
	value,
	hint,
}: {
	label: string;
	value: string;
	hint: string;
}) {
	return (
		<div className="min-w-0 px-4 py-4">
			<p className="text-xs text-muted-foreground">{label}</p>
			<p className="mt-2 font-mono text-2xl font-medium tabular-nums">
				{value}
			</p>
			<p className="mt-1 text-xs text-muted-foreground">{hint}</p>
		</div>
	);
}

function SignalBar({
	label,
	value,
	tone,
	empty = false,
}: {
	label: string;
	value: number;
	tone: "cite" | "survey" | "destructive";
	empty?: boolean;
}) {
	const bounded = Math.max(0, Math.min(1, value));
	return (
		<div className="grid grid-cols-[5rem_minmax(0,1fr)_3rem] items-center gap-3">
			<span className="text-ui text-muted-foreground">{label}</span>
			<div className="h-1.5 overflow-hidden rounded-full bg-muted">
				<div
					className={cn(
						"h-full rounded-full",
						tone === "cite" && "bg-cite",
						tone === "survey" && "bg-survey",
						tone === "destructive" && "bg-destructive",
					)}
					style={{ width: `${bounded * 100}%` }}
				/>
			</div>
			<span className="text-right font-mono text-xs tabular-nums">
				{empty ? "--" : percent(bounded)}
			</span>
		</div>
	);
}

function StageLatencyTable({
	title,
	rows,
}: {
	title: string;
	rows: StageLatency[];
}) {
	return (
		<section className="min-w-0" aria-label={title}>
			<div className="flex items-center justify-between border-border border-b py-3">
				<h3 className="text-base font-medium">{title}</h3>
			</div>
			{rows.length ? (
				<div className="divide-y divide-border/60">
					<div className="grid grid-cols-[minmax(0,1fr)_3.5rem_3.5rem_4rem] gap-2 py-3 text-xs text-muted-foreground sm:grid-cols-[minmax(0,1fr)_4.5rem_4.5rem_5rem]">
						<span>阶段</span>
						<span className="text-right">P50</span>
						<span className="text-right">P95</span>
						<span className="text-right">失败/样本</span>
					</div>
					{rows.slice(0, 8).map((row) => (
						<div
							key={row.stage}
							className="grid grid-cols-[minmax(0,1fr)_3.5rem_3.5rem_4rem] items-center gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_4.5rem_4.5rem_5rem]"
						>
							<span className="truncate text-ui" title={row.stage}>
								{stageDisplayName(row.stage)}
							</span>
							<span className="text-right font-mono text-xs tabular-nums text-muted-foreground">
								{latency(row.p50)}
							</span>
							<span className="text-right font-mono text-xs tabular-nums">
								{latency(row.p95)}
							</span>
							<span
								className={cn(
									"text-right font-mono text-xs tabular-nums text-muted-foreground",
									row.failed > 0 && "text-destructive",
								)}
							>
								{row.failed}/{row.count}
							</span>
						</div>
					))}
				</div>
			) : (
				<p className="px-4 py-5 text-ui text-muted-foreground">
					等待阶段样本。
				</p>
			)}
		</section>
	);
}

export function OperationsDashboard() {
	const id = useId();
	const canManage = useCan("manageMembers");
	const { identity } = useSession();
	const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [autoRefresh, setAutoRefresh] = useState(true);
	const [view, setView] = useState<"overview" | "requests">("overview");
	const [selectedError, setSelectedError] = useState<OperationsErrorRef | null>(
		null,
	);
	const hasSnapshot = useRef(false);
	const requestSequence = useRef(0);

	const load = useCallback(async () => {
		if (!canManage) return;
		const sequence = ++requestSequence.current;
		setLoading(true);
		setError(null);
		const controller = new AbortController();
		const timeout = window.setTimeout(() => controller.abort(), 8_000);
		try {
			const response = await fetch("/api/workspace/operations", {
				cache: "no-store",
				signal: controller.signal,
			});
			if (!response.ok) throw new Error(`operations_http_${response.status}`);
			const payload = (await response.json()) as OperationsSnapshot;
			if (payload.scope.workspace_id !== identity.workspaceId) {
				throw new Error("operations_scope_mismatch");
			}
			if (sequence !== requestSequence.current) return;
			setSnapshot(payload);
			hasSnapshot.current = true;
		} catch {
			if (sequence !== requestSequence.current) return;
			setError(
				hasSnapshot.current
					? "刷新失败，当前显示上一次成功快照"
					: "运行数据暂时不可用",
			);
		} finally {
			window.clearTimeout(timeout);
			if (sequence === requestSequence.current) setLoading(false);
		}
	}, [canManage, identity.workspaceId]);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		if (!autoRefresh || !canManage || view !== "overview") return;
		const timer = window.setInterval(() => void load(), 30_000);
		return () => window.clearInterval(timer);
	}, [autoRefresh, canManage, load, view]);

	const activeAlerts = useMemo(
		() => snapshot?.alerts.filter((alert) => alert.status === "active") ?? [],
		[snapshot],
	);
	const releaseState = useMemo(() => {
		if (
			!snapshot ||
			error ||
			snapshot.overall.stale ||
			snapshot.overall.status === "unknown"
		) {
			return {
				label: error || snapshot?.overall.stale ? "状态已过期" : "状态未知",
				tone: "warning" as const,
				icon: AlertTriangle,
			};
		}
		const alerts = activeAlerts;
		if (snapshot.overall.status === "unavailable") {
			return { label: "服务不可用", tone: "danger" as const, icon: Ban };
		}
		if (alerts.some((alert) => alert.severity === "critical")) {
			return { label: "存在严重告警", tone: "danger" as const, icon: Ban };
		}
		if (
			snapshot.overall.status === "degraded" ||
			alerts.some((alert) => alert.severity === "warning")
		) {
			return {
				label: "需要关注",
				tone: "warning" as const,
				icon: AlertTriangle,
			};
		}
		return {
			label: "运行稳定",
			tone: "good" as const,
			icon: CheckCircle2,
		};
	}, [activeAlerts, error, snapshot]);

	if (!canManage) {
		return (
			<div className="flex flex-1 items-center justify-center p-8 text-ui text-muted-foreground">
				仅工作区管理员可查看运行中心。
			</div>
		);
	}

	const ReleaseIcon = releaseState.icon;
	const ask = snapshot?.ask;
	const jobs = snapshot?.jobs;
	const terminalAskCount = ask
		? ask.completed + ask.refused + ask.failed + ask.cancelled
		: 0;
	const successRate = terminalAskCount
		? (ask?.completed ?? 0) / terminalAskCount
		: 0;
	const refusalRate = terminalAskCount
		? (ask?.refused ?? 0) / terminalAskCount
		: 0;
	const citationCoverage = ask?.completed
		? Math.max(0, ask.completed - ask.without_citations) / ask.completed
		: 0;

	return (
		<div className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
			<div className="mx-auto w-full max-w-7xl space-y-6">
				<header className="flex flex-wrap items-end justify-between gap-4">
					<div className="min-w-0">
						<h2 className="text-2xl font-medium">运行中心</h2>
						<p className="mt-2 text-xs text-muted-foreground">
							{snapshot
								? `最近 ${snapshot.window.hours} 小时 · 更新于 ${formatDateTime(snapshot.generated_at)}`
								: loading
									? "正在读取运行状态"
									: "暂无运行快照"}
						</p>
					</div>
					{view === "overview" ? (
						<div className="flex items-center gap-3">
							<label
								htmlFor={`${id}-auto-refresh`}
								className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-xs text-muted-foreground"
							>
								<Switch
									id={`${id}-auto-refresh`}
									checked={autoRefresh}
									onCheckedChange={setAutoRefresh}
								/>
								30s 自动刷新
							</label>
							<Button
								variant="outline"
								size="icon"
								className="size-11"
								onClick={() => void load()}
								disabled={loading}
								title="刷新运行数据"
							>
								<RefreshCw className={cn(loading && "animate-spin")} />
								<span className="sr-only">刷新运行数据</span>
							</Button>
						</div>
					) : null}
				</header>
				<fieldset
					className="flex min-w-0 gap-4 border-b border-border"
					aria-label="运行中心视图"
				>
					{(
						[
							["overview", "概览"],
							["requests", "请求记录"],
						] as const
					).map(([value, label]) => (
						<button
							key={value}
							type="button"
							aria-pressed={view === value}
							onClick={() => setView(value)}
							className={cn(
								"min-h-11 border-b-2 px-2 text-sm font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
								view === value
									? "border-evidence text-evidence"
									: "border-transparent text-muted-foreground hover:text-foreground",
							)}
						>
							{label}
						</button>
					))}
				</fieldset>
				{view === "requests" ? (
					<OperationsRequestsPanel
						key={`${identity.tenantId}:${identity.workspaceId}`}
						onSelect={setSelectedError}
					/>
				) : (
					<>
						{error ? (
							<div
								role="alert"
								className="flex items-center gap-2 border-l-2 border-destructive bg-destructive/5 px-4 py-3 text-sm text-destructive"
							>
								<ShieldAlert className="size-4 shrink-0" />
								{error}
							</div>
						) : null}
						<section
							aria-label="运行状态"
							className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-5"
						>
							<div
								className={cn(
									"flex items-center gap-2 text-sm font-medium",
									releaseState.tone === "good" && "text-cite",
									releaseState.tone === "warning" && "text-warning-foreground",
									releaseState.tone === "danger" && "text-destructive",
								)}
							>
								<ReleaseIcon className="size-4" />
								<span>{releaseState.label}</span>
							</div>
							<div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
								<span>
									{snapshot
										? `${activeAlerts.length} 项活动告警`
										: "告警状态未知"}
								</span>
								<span className="font-mono">
									{snapshot ? formatReleaseVersion(snapshot.release) : "--"}
								</span>
							</div>
						</section>
						<section
							aria-label="问答指标"
							className="grid grid-cols-2 border-b border-border xl:grid-cols-5"
						>
							<MetricCell
								label="问答请求"
								value={ask ? String(ask.total) : "--"}
								hint={
									ask
										? `${ask.failed} 失败 · ${ask.cancelled} 取消`
										: "等待统计"
								}
							/>
							<MetricCell
								label="回答完成率"
								value={terminalAskCount ? percent(successRate) : "--"}
								hint={
									ask
										? `${ask.completed} 次完成 / ${terminalAskCount} 次终态`
										: "等待统计"
								}
							/>
							<MetricCell
								label="拒答率"
								value={terminalAskCount ? percent(refusalRate) : "--"}
								hint={ask ? `${ask.refused} 次证据拒答` : "等待统计"}
							/>
							<MetricCell
								label="引用覆盖率"
								value={ask?.completed ? percent(citationCoverage) : "--"}
								hint="完成回答的引用覆盖"
							/>
							<MetricCell
								label="请求耗时 P95"
								value={latency(ask?.latency_ms.p95 ?? null)}
								hint={`P50 ${latency(ask?.latency_ms.p50 ?? null)}`}
							/>
						</section>
						<div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
							<section aria-label="问答结果分布" className="min-w-0">
								<div className="flex items-center justify-between border-b border-border py-3">
									<h3 className="text-base font-medium">问答结果分布</h3>
									<TimerReset className="size-4 text-muted-foreground" />
								</div>
								<div className="space-y-4 py-5">
									<SignalBar
										label="完成率"
										value={successRate}
										tone="cite"
										empty={terminalAskCount === 0}
									/>
									<SignalBar
										label="引用覆盖"
										value={citationCoverage}
										tone="cite"
										empty={!ask?.completed}
									/>
									<SignalBar
										label="拒答率"
										value={refusalRate}
										tone="survey"
										empty={terminalAskCount === 0}
									/>
									<SignalBar
										label="失败率"
										value={ask?.total ? ask.failed / ask.total : 0}
										tone="destructive"
										empty={!ask?.total}
									/>
								</div>
							</section>
							<section aria-label="任务队列" className="min-w-0">
								<div className="flex items-center justify-between border-b border-border py-3">
									<h3 className="text-base font-medium">任务队列</h3>
									<Clock3 className="size-4 text-muted-foreground" />
								</div>
								<dl className="grid grid-cols-3 gap-x-4 gap-y-5 py-5">
									{[
										["等待", jobs?.queued],
										["执行", jobs?.running],
										["终止失败", jobs?.dead],
										["超时未推进", jobs?.stuck],
										["待恢复删除", jobs?.delete_failed],
									].map(([label, value]) => (
										<div key={label} className="min-w-0">
											<dt className="text-xs text-muted-foreground">{label}</dt>
											<dd className="mt-2 font-mono text-xl tabular-nums">
												{value ?? "--"}
											</dd>
										</div>
									))}
									<div className="min-w-0">
										<dt className="text-xs text-muted-foreground">
											最老活动任务
										</dt>
										<dd className="mt-2 break-words font-mono text-sm">
											{jobs?.oldest_active
												? formatDurationMs(jobs.oldest_active.age_ms)
												: "--"}
										</dd>
									</div>
								</dl>
							</section>
						</div>
						<div className="grid min-w-0 gap-6 xl:grid-cols-2">
							<StageLatencyTable
								title="Ask 阶段延迟"
								rows={ask?.stage_latency_ms ?? []}
							/>
							<StageLatencyTable
								title="入库阶段延迟"
								rows={jobs?.stage_latency_ms ?? []}
							/>
						</div>
						<section aria-label="组件健康" className="min-w-0">
							<div className="flex items-center gap-2 border-b border-border py-3">
								<Database className="size-4 text-muted-foreground" />
								<h3 className="text-base font-medium">组件健康</h3>
							</div>
							{snapshot?.components.length ? (
								<ul className="grid sm:grid-cols-2 xl:grid-cols-4">
									{snapshot.components.map((component) => (
										<li
											key={component.code}
											className="min-w-0 border-b border-border/60 py-4 sm:pr-5"
										>
											<div className="flex flex-wrap items-center justify-between gap-2">
												<span className="text-sm font-medium">
													{component.label}
												</span>
												<span
													className={cn(
														"text-xs",
														component.stale
															? "text-warning-foreground"
															: component.status === "healthy"
																? "text-cite"
																: component.status === "degraded"
																	? "text-destructive"
																	: "text-muted-foreground",
													)}
												>
													{component.stale
														? "探测已过期"
														: component.status === "healthy"
															? component.mode === "configuration"
																? "配置就绪"
																: "正常"
															: component.status === "degraded"
																? "异常"
																: component.status === "disabled"
																	? "未启用"
																	: "未知"}
												</span>
											</div>
											<p className="mt-2 text-xs text-muted-foreground">
												{component.mode === "active" ? "主动探测" : "配置检查"}
												{component.latency_ms == null
													? ""
													: ` · ${formatDurationMs(component.latency_ms)}`}
											</p>
											<p className="mt-1 break-words text-xs text-muted-foreground">
												检查于 {formatDateTime(component.checked_at)}
											</p>
											{component.status === "degraded" || component.stale ? (
												<p className="mt-2 break-words text-sm text-muted-foreground">
													{component.recovery}
												</p>
											) : null}
										</li>
									))}
								</ul>
							) : (
								<p className="py-5 text-sm text-muted-foreground">
									等待首次健康评估。
								</p>
							)}
						</section>
						<section aria-label="活动告警" className="min-w-0">
							<div className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-3">
								<div className="flex items-center gap-2">
									<BellRing className="size-4 text-muted-foreground" />
									<h3 className="text-base font-medium">活动告警</h3>
								</div>
								<Link
									href="/app/settings#notifications"
									className="inline-flex min-h-11 items-center text-sm text-evidence underline-offset-4 hover:underline"
								>
									通知设置
								</Link>
							</div>
							<p className="py-3 text-xs text-muted-foreground">
								{snapshot
									? `Webhook ${snapshot.notifications.webhook ? "已配置" : "未配置"} · 邮件 ${snapshot.notifications.email ? "已配置" : "未配置"}`
									: "通知配置未知"}
							</p>
							{activeAlerts.length ? (
								<ul className="divide-y divide-border/60">
									{activeAlerts.map((alert) => (
										<li
											key={alert.id}
											className="grid min-w-0 gap-3 py-4 lg:grid-cols-[minmax(0,1fr)_12rem]"
										>
											<div className="min-w-0">
												<div className="flex flex-wrap items-center gap-3">
													<span
														className={cn(
															"text-xs font-medium",
															alert.severity === "critical"
																? "text-destructive"
																: alert.severity === "warning"
																	? "text-warning-foreground"
																	: "text-muted-foreground",
														)}
													>
														{alert.severity === "critical"
															? "严重"
															: alert.severity === "warning"
																? "警告"
																: "提示"}
													</span>
													<h4 className="text-sm font-medium">{alert.title}</h4>
												</div>
												<p className="mt-2 break-words text-sm">
													{alert.detail}
												</p>
												<p className="mt-2 break-words text-xs text-muted-foreground">
													{alert.recovery}
												</p>
											</div>
											<dl className="space-y-1 text-xs text-muted-foreground">
												<div>
													<dt className="inline">首次触发 </dt>
													<dd className="inline">
														{formatDateTime(alert.first_triggered_at)}
													</dd>
												</div>
												<div>
													<dt className="inline">累计 </dt>
													<dd className="inline tabular-nums">
														{alert.occurrence_count} 次
													</dd>
												</div>
												<div>
													<dt className="inline">投递状态 </dt>
													<dd className="inline break-all">
														{alert.last_delivery_status ?? "未记录投递"}
													</dd>
												</div>
												{alert.last_delivery_at ? (
													<div>
														<dt className="inline">最近投递 </dt>
														<dd className="inline">
															{formatDateTime(alert.last_delivery_at)}
														</dd>
													</div>
												) : null}
											</dl>
										</li>
									))}
								</ul>
							) : (
								<p className="py-5 text-sm text-muted-foreground">
									{snapshot ? "当前没有活动告警。" : "告警数据尚未读取。"}
								</p>
							)}
						</section>
						<section aria-label="最近错误" className="min-w-0">
							<div className="flex items-center justify-between border-b border-border py-3">
								<h3 className="text-base font-medium">最近错误</h3>
								<span className="text-xs text-muted-foreground">
									最多 20 条
								</span>
							</div>
							{snapshot?.recent_errors.length ? (
								<ul className="divide-y divide-border/60">
									{snapshot.recent_errors.map((item) => (
										<li key={`${item.source}-${item.id}`}>
											<button
												type="button"
												aria-label={`查看${item.source === "ask" ? "请求" : "任务"}错误 ${item.id}`}
												onClick={() =>
													setSelectedError({ source: item.source, id: item.id })
												}
												className="grid min-h-11 w-full min-w-0 gap-2 rounded-sm py-4 text-left transition-colors duration-150 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring lg:grid-cols-[4rem_minmax(0,1fr)_10rem_11rem] lg:items-center"
											>
												<span className="text-xs text-muted-foreground">
													{item.source === "ask" ? "Ask" : "Job"}
												</span>
												<span className="min-w-0">
													<span className="block break-all font-mono text-xs text-destructive">
														{item.error_code}
													</span>
													<span className="mt-1 block break-all font-mono text-xs text-muted-foreground">
														{item.id}
													</span>
												</span>
												<span className="break-words text-xs">
													{item.stage
														? stageDisplayName(item.stage)
														: item.status}
												</span>
												<time
													className="text-xs tabular-nums text-muted-foreground"
													dateTime={item.occurred_at}
												>
													{formatDateTime(item.occurred_at)}
												</time>
											</button>
										</li>
									))}
								</ul>
							) : (
								<p className="py-5 text-sm text-muted-foreground">
									{snapshot ? "没有最近错误。" : "错误记录尚未读取。"}
								</p>
							)}
						</section>
						<details className="group border-t border-border py-2">
							<summary className="flex min-h-11 cursor-pointer list-none items-center justify-between text-sm font-medium">
								服务版本
								<ChevronDown className="size-4 text-muted-foreground transition-transform duration-150 group-open:rotate-180" />
							</summary>
							<dl className="grid min-w-0 gap-4 py-3 sm:grid-cols-2 xl:grid-cols-4">
								{[
									[
										"产品版本",
										snapshot ? formatReleaseVersion(snapshot.release) : "--",
									],
									["提交", snapshot?.release.revision_short ?? "--"],
									[
										"构建时间",
										snapshot?.release.built_at
											? formatDateTime(snapshot.release.built_at)
											: "--",
									],
									["DBOS", snapshot?.release.dbos_application_version ?? "--"],
								].map(([label, value]) => (
									<div key={label} className="min-w-0">
										<dt className="text-xs text-muted-foreground">{label}</dt>
										<dd className="mt-2 break-all font-mono text-xs">
											{value}
										</dd>
									</div>
								))}
							</dl>
						</details>
					</>
				)}
				<OperationsErrorDrawer
					selected={selectedError}
					onOpenChange={(open) => !open && setSelectedError(null)}
					onRecovered={() => {
						setSelectedError(null);
						void load();
					}}
				/>
			</div>
		</div>
	);
}
