"use client";

import {
	AlertTriangle,
	Ban,
	CheckCircle2,
	Clock3,
	RefreshCw,
	ShieldAlert,
	TimerReset,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useCan } from "@/components/app/can";
import { Button } from "@/components/ui/button";
import { formatDateTime, formatDurationMs } from "@/lib/format";
import { cn } from "@/lib/utils";

type AlertSeverity = "critical" | "warning" | "info";
type OperationsAlert = {
	code: string;
	severity: AlertSeverity;
	title: string;
	detail: string;
};

type OperationsSnapshot = {
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

function deriveAlerts(snapshot: OperationsSnapshot | null): OperationsAlert[] {
	if (!snapshot) return [];
	const alerts: OperationsAlert[] = [];
	const terminal =
		snapshot.ask.completed +
		snapshot.ask.refused +
		snapshot.ask.failed +
		snapshot.ask.cancelled;
	const citationCoverage = snapshot.ask.completed
		? (snapshot.ask.completed - snapshot.ask.without_citations) /
			snapshot.ask.completed
		: 1;
	if (snapshot.jobs.dead > 0) {
		alerts.push({
			code: "jobs_dead",
			severity: "critical",
			title: "存在终止任务",
			detail: `${snapshot.jobs.dead} 个任务已进入 dead，需要人工处理。`,
		});
	}
	if (snapshot.jobs.stuck > 0) {
		alerts.push({
			code: "jobs_stuck",
			severity: "critical",
			title: "任务心跳超时",
			detail: `${snapshot.jobs.stuck} 个执行中任务已超过 ${snapshot.window.stuck_after_minutes} 分钟无有效心跳。`,
		});
	}
	if (terminal >= 5 && snapshot.ask.failed / terminal >= 0.05) {
		alerts.push({
			code: "ask_failure_rate",
			severity: "warning",
			title: "Ask 失败率偏高",
			detail: `${snapshot.ask.failed}/${terminal} 个终态请求失败。`,
		});
	}
	if (snapshot.ask.completed >= 5 && citationCoverage < 0.9) {
		alerts.push({
			code: "citation_coverage",
			severity: "warning",
			title: "引用覆盖不足",
			detail: `${snapshot.ask.without_citations} 个完成回答没有引用。`,
		});
	}
	if ((snapshot.ask.latency_ms.p95 ?? 0) > 8_000) {
		alerts.push({
			code: "ask_p95_latency",
			severity: "warning",
			title: "Ask P95 延迟偏高",
			detail: `当前 P95 为 ${formatDurationMs(snapshot.ask.latency_ms.p95 ?? 0)}。`,
		});
	}
	return alerts;
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
}: {
	label: string;
	value: number;
	tone: "cite" | "survey" | "destructive";
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
				{percent(bounded)}
			</span>
		</div>
	);
}

export function OperationsDashboard() {
	const canManage = useCan("manageMembers");
	const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [autoRefresh, setAutoRefresh] = useState(true);

	const load = useCallback(async () => {
		if (!canManage) return;
		setError(null);
		try {
			const response = await fetch("/api/workspace/operations", {
				cache: "no-store",
			});
			if (!response.ok) throw new Error(`operations_http_${response.status}`);
			setSnapshot((await response.json()) as OperationsSnapshot);
		} catch {
			setError("运行数据暂时不可用");
		} finally {
			setLoading(false);
		}
	}, [canManage]);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		if (!autoRefresh || !canManage) return;
		const timer = window.setInterval(() => void load(), 30_000);
		return () => window.clearInterval(timer);
	}, [autoRefresh, canManage, load]);

	const activeAlerts = useMemo(() => deriveAlerts(snapshot), [snapshot]);
	const releaseState = useMemo(() => {
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
	}, [activeAlerts]);

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
						value={percent(successRate)}
						hint={`${ask?.completed ?? 0} 次完成`}
						tone={
							terminalAskCount === 0 || successRate >= 0.98 ? "good" : "warning"
						}
					/>
					<MetricCell
						label="Refusal"
						value={percent(refusalRate)}
						hint={`${ask?.refused ?? 0} 次证据拒答`}
						tone={refusalRate > 0.2 ? "warning" : "default"}
					/>
					<MetricCell
						label="Citation"
						value={percent(citationCoverage)}
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
							<SignalBar label="完成率" value={successRate} tone="cite" />
							<SignalBar
								label="引用覆盖"
								value={citationCoverage}
								tone="cite"
							/>
							<SignalBar label="拒答率" value={refusalRate} tone="survey" />
							<SignalBar
								label="失败率"
								value={ask?.total ? ask.failed / ask.total : 0}
								tone="destructive"
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
						<h3 className="text-ui font-semibold">活动告警</h3>
						<span className="font-mono text-xs text-muted-foreground">
							{activeAlerts.length}
						</span>
					</div>
					{activeAlerts.length ? (
						<div className="divide-y divide-border/70">
							{activeAlerts.map((alert) => (
								<div
									key={alert.code}
									className="grid gap-1 px-4 py-3 sm:grid-cols-[8rem_12rem_minmax(0,1fr)] sm:items-center sm:gap-4"
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
									<span className="text-ui text-muted-foreground">
										{alert.detail}
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
