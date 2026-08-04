"use client";

import {
	AlertTriangle,
	Ban,
	BellRing,
	CheckCircle2,
	Clock3,
	Database,
	RefreshCw,
	ShieldAlert,
	TimerReset,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCan } from "@/components/app/can";
import { useSession } from "@/components/app/session-provider";
import { Button } from "@/components/ui/button";
import { formatDateTime, formatDurationMs } from "@/lib/format";
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
		without_citations: number;
	};
	jobs: {
		queued: number;
		running: number;
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
		source: "ask" | "job";
		status: string;
		error_code: string;
		occurred_at: string;
		job_type: string | null;
	}>;
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
	tone = "default",
}: {
	label: string;
	value: string;
	hint: string;
	tone?: "default" | "good" | "warning" | "danger";
}) {
	return (
		<div className="min-w-0 border-border/80 border-b px-4 py-4 last:border-b-0 sm:border-r sm:border-b-0 sm:last:border-r-0">
			<p className="text-meta font-mono tracking-[0.12em] text-muted-foreground uppercase">
				{label}
			</p>
			<p
				className={cn(
					"mt-2 font-mono text-2xl font-medium tabular-nums",
					tone === "good" && "text-cite",
					tone === "warning" && "text-survey",
					tone === "danger" && "text-destructive",
				)}
			>
				{value}
			</p>
			<p className="text-ui mt-1 truncate text-muted-foreground">{hint}</p>
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
		<div className="grid grid-cols-[7rem_minmax(0,1fr)_3rem] items-center gap-3">
			<span className="text-ui text-muted-foreground">{label}</span>
			<div className="h-1.5 overflow-hidden rounded-full bg-muted">
				<div
					className={cn(
						"h-full rounded-full transition-[width] duration-300",
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

export function OperationsDashboard() {
	const canManage = useCan("manageMembers");
	const { identity } = useSession();
	const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [autoRefresh, setAutoRefresh] = useState(true);
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
		if (!autoRefresh || !canManage) return;
		const timer = window.setInterval(() => void load(), 30_000);
		return () => window.clearInterval(timer);
	}, [autoRefresh, canManage, load]);

	const activeAlerts = useMemo(
		() => snapshot?.alerts.filter((alert) => alert.status === "active") ?? [],
		[snapshot],
	);
	const releaseState = useMemo(() => {
		if (!snapshot || error || snapshot.overall.status === "unknown") {
			return {
				label: error ? "状态已过期" : "状态未知",
				tone: "warning" as const,
				icon: AlertTriangle,
			};
		}
		const alerts = activeAlerts;
		if (alerts.some((alert) => alert.severity === "critical")) {
			return { label: "发布阻断", tone: "danger" as const, icon: Ban };
		}
		if (alerts.some((alert) => alert.severity === "warning")) {
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
		<div className="flex flex-1 flex-col px-5 py-7 sm:px-6 lg:px-8 lg:py-9">
			<div className="mx-auto w-full max-w-7xl space-y-6">
				<header className="flex flex-col gap-4 border-border/80 border-b pb-5 sm:flex-row sm:items-end sm:justify-between">
					<div>
						<p className="text-meta font-mono tracking-[0.2em] text-cite uppercase">
							Operations
						</p>
						<h2 className="mt-1 font-heading text-2xl font-semibold">
							运行中心
						</h2>
						<p className="text-ui mt-1 text-muted-foreground">
							{snapshot
								? `最近 ${snapshot.window.hours} 小时 · ${formatDateTime(new Date(snapshot.generated_at).getTime())}`
								: "正在读取运行状态"}
						</p>
					</div>
					<div className="flex items-center gap-3">
						<label className="text-ui inline-flex items-center gap-2 text-muted-foreground">
							<input
								type="checkbox"
								checked={autoRefresh}
								onChange={(event) => setAutoRefresh(event.target.checked)}
								className="size-3.5 accent-primary"
							/>
							30s 自动刷新
						</label>
						<Button
							variant="outline"
							size="icon"
							onClick={() => void load()}
							disabled={loading}
							title="刷新运行数据"
						>
							<RefreshCw className={cn(loading && "animate-spin")} />
							<span className="sr-only">刷新运行数据</span>
						</Button>
					</div>
				</header>

				{error ? (
					<div className="flex items-center gap-2 border border-destructive/30 bg-destructive/5 px-4 py-3 text-ui text-destructive">
						<ShieldAlert className="size-4" />
						{error}
					</div>
				) : null}

				<section
					className={cn(
						"flex items-center justify-between gap-4 border px-4 py-3",
						releaseState.tone === "good" &&
							"border-cite/30 bg-cite/5 text-cite",
						releaseState.tone === "warning" &&
							"border-survey/35 bg-survey/5 text-survey",
						releaseState.tone === "danger" &&
							"border-destructive/35 bg-destructive/5 text-destructive",
					)}
				>
					<div className="flex items-center gap-2.5">
						<ReleaseIcon className="size-4" />
						<span className="text-ui font-semibold">{releaseState.label}</span>
					</div>
					<span className="font-mono text-xs tabular-nums">
						{activeAlerts.length} signals
					</span>
				</section>

				<section className="grid overflow-hidden border border-border/80 bg-card sm:grid-cols-2 xl:grid-cols-5">
					<MetricCell
						label="Ask requests"
						value={String(ask?.total ?? 0)}
						hint={`${ask?.failed ?? 0} 失败 · ${ask?.cancelled ?? 0} 取消`}
					/>
					<MetricCell
						label="Success"
						value={terminalAskCount ? percent(successRate) : "--"}
						hint={`${ask?.completed ?? 0} 次完成`}
						tone={
							terminalAskCount === 0 || successRate >= 0.98 ? "good" : "warning"
						}
					/>
					<MetricCell
						label="Refusal"
						value={terminalAskCount ? percent(refusalRate) : "--"}
						hint={`${ask?.refused ?? 0} 次证据拒答`}
						tone={refusalRate > 0.2 ? "warning" : "default"}
					/>
					<MetricCell
						label="Citation"
						value={ask?.completed ? percent(citationCoverage) : "--"}
						hint="完成回答引用覆盖"
						tone={
							!ask?.completed || citationCoverage >= 0.9 ? "good" : "danger"
						}
					/>
					<MetricCell
						label="P95 latency"
						value={latency(ask?.latency_ms.p95 ?? null)}
						hint={`P50 ${latency(ask?.latency_ms.p50 ?? null)}`}
						tone={(ask?.latency_ms.p95 ?? 0) > 8_000 ? "warning" : "default"}
					/>
				</section>

				<div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(22rem,0.9fr)]">
					<section className="min-w-0 border border-border/80 bg-card">
						<div className="flex items-center justify-between border-border/80 border-b px-4 py-3">
							<h3 className="text-ui font-semibold">Ask 质量</h3>
							<TimerReset className="size-4 text-muted-foreground" />
						</div>
						<div className="space-y-4 px-4 py-5">
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

					<section className="min-w-0 border border-border/80 bg-card">
						<div className="flex items-center justify-between border-border/80 border-b px-4 py-3">
							<h3 className="text-ui font-semibold">任务队列</h3>
							<Clock3 className="size-4 text-muted-foreground" />
						</div>
						<div className="grid grid-cols-3 border-border/80 border-b">
							{[
								["等待", jobs?.queued ?? 0],
								["执行", jobs?.running ?? 0],
								["异常", (jobs?.dead ?? 0) + (jobs?.stuck ?? 0)],
							].map(([label, value]) => (
								<div
									key={label}
									className="border-border/80 border-r px-3 py-4 text-center last:border-r-0"
								>
									<p className="font-mono text-xl tabular-nums">{value}</p>
									<p className="text-meta mt-1 text-muted-foreground">
										{label}
									</p>
								</div>
							))}
						</div>
						<div className="grid grid-cols-2 gap-px bg-border/80">
							<div className="bg-card px-4 py-3">
								<p className="text-meta text-muted-foreground">Dead / Stuck</p>
								<p
									className={cn(
										"mt-1 font-mono text-sm",
										(jobs?.dead ?? 0) + (jobs?.stuck ?? 0) > 0 &&
											"text-destructive",
									)}
								>
									{jobs?.dead ?? 0} / {jobs?.stuck ?? 0}
								</p>
							</div>
							<div className="bg-card px-4 py-3">
								<p className="text-meta text-muted-foreground">最老活动任务</p>
								<p className="mt-1 truncate font-mono text-sm">
									{jobs?.oldest_active
										? formatDurationMs(jobs.oldest_active.age_ms)
										: "--"}
								</p>
							</div>
						</div>
					</section>
				</div>

				<section className="min-w-0 border border-border/80 bg-card">
					<div className="flex items-center justify-between border-border/80 border-b px-4 py-3">
						<div className="flex items-center gap-2">
							<Database className="size-4 text-muted-foreground" />
							<h3 className="text-ui font-semibold">组件健康</h3>
						</div>
						<span className="font-mono text-xs text-muted-foreground">
							{snapshot?.components.length ?? 0}
						</span>
					</div>
					{snapshot?.components.length ? (
						<div className="grid sm:grid-cols-2 xl:grid-cols-4">
							{snapshot.components.map((component) => (
								<div
									key={component.code}
									className="min-w-0 border-border/70 border-b px-4 py-3 sm:border-r xl:[&:nth-last-child(-n+4)]:border-b-0"
								>
									<div className="flex items-center justify-between gap-3">
										<span className="text-ui font-medium">
											{component.label}
										</span>
										<span
											className={cn(
												"font-mono text-[10px] uppercase",
												component.status === "healthy" && "text-cite",
												component.status === "degraded" && "text-destructive",
												(component.status === "unknown" ||
													component.status === "disabled") &&
													"text-muted-foreground",
											)}
										>
											{component.status}
										</span>
									</div>
									<p className="text-meta mt-1 font-mono text-muted-foreground">
										{component.mode === "active" ? "主动探测" : "配置检查"}
										{component.latency_ms == null
											? ""
											: ` · ${component.latency_ms}ms`}
									</p>
									{component.status === "degraded" || component.stale ? (
										<p className="text-ui mt-2 text-muted-foreground">
											{component.recovery}
										</p>
									) : null}
								</div>
							))}
						</div>
					) : (
						<p className="text-ui px-4 py-5 text-muted-foreground">
							等待首次健康评估。
						</p>
					)}
				</section>

				<section className="min-w-0 border border-border/80 bg-card">
					<div className="flex items-center justify-between border-border/80 border-b px-4 py-3">
						<div className="flex items-center gap-2">
							<BellRing className="size-4 text-muted-foreground" />
							<h3 className="text-ui font-semibold">活动告警</h3>
						</div>
						<span className="font-mono text-xs text-muted-foreground">
							{activeAlerts.length} · webhook{" "}
							{snapshot?.notifications.webhook ? "on" : "off"} · email{" "}
							{snapshot?.notifications.email ? "on" : "off"}
						</span>
					</div>
					{activeAlerts.length ? (
						<div className="divide-y divide-border/70">
							{activeAlerts.map((alert) => (
								<div
									key={alert.id}
									className="grid gap-1 px-4 py-3 sm:grid-cols-[7rem_12rem_minmax(0,1fr)_8rem] sm:items-center sm:gap-4"
								>
									<span
										className={cn(
											"w-fit rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase",
											alert.severity === "critical" &&
												"border-destructive/30 bg-destructive/5 text-destructive",
											alert.severity === "warning" &&
												"border-survey/30 bg-survey/5 text-survey",
											alert.severity === "info" &&
												"border-border text-muted-foreground",
										)}
									>
										{alert.severity}
									</span>
									<span className="text-ui font-medium">{alert.title}</span>
									<div className="min-w-0">
										<p className="text-ui text-muted-foreground">
											{alert.detail}
										</p>
										<p className="text-meta mt-1 text-muted-foreground">
											{alert.recovery}
										</p>
									</div>
									<span className="text-right font-mono text-xs text-muted-foreground">
										{alert.last_delivery_status ?? "in-app"}
									</span>
								</div>
							))}
						</div>
					) : (
						<p className="text-ui px-4 py-5 text-muted-foreground">
							当前没有活动告警。
						</p>
					)}
				</section>

				<section className="min-w-0 overflow-hidden border border-border/80 bg-card">
					<div className="flex items-center justify-between border-border/80 border-b px-4 py-3">
						<h3 className="text-ui font-semibold">最近错误</h3>
						<span className="font-mono text-xs text-muted-foreground">
							最多 20 条
						</span>
					</div>
					<div className="overflow-x-auto">
						<table className="w-full min-w-[44rem] text-left text-ui">
							<thead className="bg-muted/45 text-muted-foreground">
								<tr>
									<th className="px-4 py-2 font-medium">来源</th>
									<th className="px-4 py-2 font-medium">状态</th>
									<th className="px-4 py-2 font-medium">错误码</th>
									<th className="px-4 py-2 font-medium">标识</th>
									<th className="px-4 py-2 text-right font-medium">时间</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-border/70">
								{snapshot?.recent_errors.length ? (
									snapshot.recent_errors.map((item) => (
										<tr key={`${item.source}-${item.id}`}>
											<td className="px-4 py-2.5">
												{item.source === "ask" ? "Ask" : "Job"}
											</td>
											<td className="px-4 py-2.5 font-mono text-xs">
												{item.status}
											</td>
											<td className="px-4 py-2.5 font-mono text-xs text-destructive">
												{item.error_code}
											</td>
											<td className="max-w-48 truncate px-4 py-2.5 font-mono text-xs text-muted-foreground">
												{item.id}
											</td>
											<td className="px-4 py-2.5 text-right font-mono text-xs text-muted-foreground">
												{formatDateTime(new Date(item.occurred_at).getTime())}
											</td>
										</tr>
									))
								) : (
									<tr>
										<td
											colSpan={5}
											className="px-4 py-6 text-center text-muted-foreground"
										>
											没有最近错误。
										</td>
									</tr>
								)}
							</tbody>
						</table>
					</div>
				</section>
			</div>
		</div>
	);
}
