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
import { OperationsFeedbackPanel } from "@/components/app/operations-feedback-panel";
import { OperationsRequestsPanel } from "@/components/app/operations-requests-panel";
import { useSession } from "@/components/app/session-provider";
import { localizeHealthRecovery } from "@/components/app/settings/health-recovery";
import { stageDisplayName } from "@/components/app/stage-waterfall";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { formatDateTime, formatDurationMs } from "@/lib/format";
import { useInterfaceLanguage, useInterfaceText } from "@/lib/i18n/provider";
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
	const t = useInterfaceText();
	const { locale } = useInterfaceLanguage();
	return (
		<section className="min-w-0" aria-label={title}>
			<div className="flex items-center justify-between border-border border-b py-3">
				<h3 className="text-base font-medium">{title}</h3>
			</div>
			{rows.length ? (
				<div className="divide-y divide-border/60">
					<div className="grid grid-cols-[minmax(0,1fr)_3.5rem_3.5rem_4rem] gap-2 py-3 text-xs text-muted-foreground sm:grid-cols-[minmax(0,1fr)_4.5rem_4.5rem_5rem]">
						<span>{t("阶段", "Stage")}</span>
						<span className="text-right">P50</span>
						<span className="text-right">P95</span>
						<span className="text-right">
							{t("失败/样本", "Failures / samples")}
						</span>
					</div>
					{rows.slice(0, 8).map((row) => (
						<div
							key={row.stage}
							className="grid grid-cols-[minmax(0,1fr)_3.5rem_3.5rem_4rem] items-center gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_4.5rem_4.5rem_5rem]"
						>
							<span className="truncate text-ui" title={row.stage}>
								{stageDisplayName(row.stage, locale)}
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
					{t("等待阶段样本。", "Waiting for stage samples.")}
				</p>
			)}
		</section>
	);
}

function localizeComponentLabel(
	code: string,
	label: string,
	locale: "zh-CN" | "en",
): string {
	if (locale === "zh-CN") return label;
	if (code === "email_delivery" || label === "邮件服务") return "Email service";
	return label;
}

const PROVIDER_RECOVERY_EN: Record<string, string> = {
	postgres:
		"Check database connectivity, capacity, and runtime role permissions.",
	redis: "Check the Redis service, network connection, and REDIS_URL.",
	redis_not_configured: "Set REDIS_URL and confirm the service is reachable.",
	qdrant: "Check the Qdrant service, collection, and API key.",
	mineru:
		"Check the MinerU endpoint, credentials, and EXTERNAL_PARSER_ALLOWED.",
	liteparse:
		"Check the local LiteParse dependencies, OCR language codes, and installed language data.",
	email_delivery:
		"Check EMAIL_PROVIDER, EMAIL_FROM, and RESEND_API_KEY. Confirm message delivery separately.",
};

function localizeComponentRecovery(
	code: string,
	errorCode: string | null,
	recovery: string,
	locale: "zh-CN" | "en",
): string {
	if (locale === "en" && /\p{Script=Han}/u.test(recovery)) {
		const translated =
			PROVIDER_RECOVERY_EN[errorCode ?? ""] ?? PROVIDER_RECOVERY_EN[code];
		if (translated && errorCode !== "embedding_dimension_mismatch")
			return translated;
	}
	return localizeHealthRecovery(
		recovery,
		errorCode ?? `${code}_not_configured`,
		locale,
	);
}

function localizeAlert(
	alert: OperationsAlert,
	locale: "zh-CN" | "en",
): { title: string; detail: string; recovery: string } {
	if (locale === "zh-CN") {
		return {
			title: alert.title,
			detail: alert.detail,
			recovery: alert.code.startsWith("provider.")
				? localizeComponentRecovery(
						alert.code.slice("provider.".length),
						alert.detail.match(/健康检查返回\s+([^。]+)/)?.[1] ?? null,
						alert.recovery,
						locale,
					)
				: alert.recovery,
		};
	}
	switch (alert.code) {
		case "jobs.delete_failed": {
			const count = alert.detail.match(/\d+/)?.[0];
			return {
				title: "Deletion cleanup awaiting recovery",
				detail: count
					? `${count} document deletion job(s) exhausted retries.`
					: alert.detail,
				recovery:
					'Confirm dependency health in Recent errors, then use "Retry cleanup" to enqueue an idempotent job.',
			};
		}
		case "jobs.dead": {
			const count = alert.detail.match(/\d+/)?.[0];
			return {
				title: "Dead jobs detected",
				detail: count ? `${count} job(s) entered dead state.` : alert.detail,
				recovery:
					"Inspect the failure category in job details, fix the dependency, and trigger an idempotent retry.",
			};
		}
		case "jobs.stuck": {
			const count = alert.detail.match(/\d+/)?.[0];
			return {
				title: "Job heartbeat timed out",
				detail: count
					? `${count} running job(s) missed heartbeat.`
					: alert.detail,
				recovery:
					"Check DBOS worker and dependency health, confirm the lease, then retry.",
			};
		}
		case "ask.failure_rate": {
			const ratio = alert.detail.match(/\d+\/\d+/)?.[0];
			return {
				title: "Elevated Ask failure rate",
				detail: ratio ? `${ratio} terminal requests failed.` : alert.detail,
				recovery:
					"Check model, retrieval dependencies, and timeout settings via recent error codes.",
			};
		}
		case "ask.citation_coverage": {
			const count = alert.detail.match(/\d+/)?.[0];
			return {
				title: "Low citation coverage",
				detail: count
					? `${count} completed answer(s) had no citations.`
					: alert.detail,
				recovery:
					"Check retrieval thresholds, refusal policy, and citation generation.",
			};
		}
		case "ask.p95_latency": {
			const ms = alert.detail.match(/\d+/)?.[0];
			return {
				title: "Elevated Ask P95 latency",
				detail: ms ? `Current P95 is ${ms} ms.` : alert.detail,
				recovery:
					"Use stage latency to isolate retrieval, rerank, or model bottlenecks.",
			};
		}
		default: {
			if (alert.code.startsWith("provider.")) {
				const providerName = alert.title.replace(/\s*状态异常$/, "");
				const errCode = alert.detail.match(/健康检查返回\s+([^。]+)/)?.[1];
				return {
					title: `${localizeComponentLabel(alert.code.slice("provider.".length), providerName, locale)} unhealthy`,
					detail: errCode ? `Health check returned ${errCode}.` : alert.detail,
					recovery: localizeComponentRecovery(
						alert.code.slice("provider.".length),
						errCode ?? null,
						alert.recovery,
						locale,
					),
				};
			}
			return {
				title: alert.title,
				detail: alert.detail,
				recovery: alert.recovery,
			};
		}
	}
}

export function OperationsDashboard() {
	const { locale } = useInterfaceLanguage();
	const t = useInterfaceText();
	const id = useId();
	const canManage = useCan("manageMembers");
	const { identity } = useSession();
	const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [autoRefresh, setAutoRefresh] = useState(true);
	const [view, setView] = useState<"overview" | "requests" | "feedback">(
		"overview",
	);
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
					? t(
							"刷新失败，当前显示上一次成功快照",
							"Refresh failed; showing the last successful snapshot",
						)
					: t(
							"运行数据暂时不可用",
							"Operations data is temporarily unavailable",
						),
			);
		} finally {
			window.clearTimeout(timeout);
			if (sequence === requestSequence.current) setLoading(false);
		}
	}, [canManage, identity.workspaceId, t]);

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
				label:
					error || snapshot?.overall.stale
						? t("状态已过期", "Stale status")
						: t("状态未知", "Unknown status"),
				tone: "warning" as const,
				icon: AlertTriangle,
			};
		}
		const alerts = activeAlerts;
		if (snapshot.overall.status === "unavailable") {
			return {
				label: t("服务不可用", "Service unavailable"),
				tone: "danger" as const,
				icon: Ban,
			};
		}
		if (alerts.some((alert) => alert.severity === "critical")) {
			return {
				label: t("存在严重告警", "Critical alerts"),
				tone: "danger" as const,
				icon: Ban,
			};
		}
		if (
			snapshot.overall.status === "degraded" ||
			alerts.some((alert) => alert.severity === "warning")
		) {
			return {
				label: t("需要关注", "Needs attention"),
				tone: "warning" as const,
				icon: AlertTriangle,
			};
		}
		return {
			label: t("运行稳定", "Operational"),
			tone: "good" as const,
			icon: CheckCircle2,
		};
	}, [activeAlerts, error, snapshot, t]);

	if (!canManage) {
		return (
			<div className="flex flex-1 items-center justify-center p-8 text-ui text-muted-foreground">
				{t(
					"仅工作区管理员可查看运行中心。",
					"Only workspace administrators can view Operations.",
				)}
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
		<div className="flex min-h-0 min-w-0 flex-1 flex-col px-4 pt-5 pb-6 sm:px-6 md:overflow-hidden md:pb-0 lg:px-8">
			<div className="mx-auto flex w-full max-w-7xl flex-col gap-4 md:min-h-0 md:flex-1 md:overflow-hidden">
				<header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-4">
					<div className="min-w-0">
						<h2 className="text-2xl font-medium">
							{t("运行中心", "Operations")}
						</h2>
						<p className="mt-1 text-xs text-muted-foreground">
							{snapshot
								? t(
										`最近 ${snapshot.window.hours} 小时 · 更新于 ${formatDateTime(snapshot.generated_at)}`,
										`Last ${snapshot.window.hours} hours · Updated ${formatDateTime(snapshot.generated_at)}`,
									)
								: loading
									? t("正在读取运行状态", "Reading operational status")
									: t("暂无运行快照", "No operations snapshot")}
						</p>
					</div>
					{view === "overview" ? (
						<div className="flex items-center gap-3">
							<label
								htmlFor={`${id}-auto-refresh`}
								className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-xs text-muted-foreground md:min-h-9"
							>
								<Switch
									id={`${id}-auto-refresh`}
									checked={autoRefresh}
									onCheckedChange={setAutoRefresh}
								/>
								{t("30s 自动刷新", "Auto-refresh every 30s")}
							</label>
							<Button
								variant="outline"
								size="icon"
								className="size-11 md:size-9"
								onClick={() => void load()}
								disabled={loading}
								title={t("刷新运行数据", "Refresh operations data")}
							>
								<RefreshCw className={cn(loading && "animate-spin")} />
								<span className="sr-only">
									{t("刷新运行数据", "Refresh operations data")}
								</span>
							</Button>
						</div>
					) : null}
				</header>
				<fieldset
					className="flex min-w-0 shrink-0 gap-4 border-b border-border"
					aria-label={t("运行中心视图", "Operations view")}
				>
					{(
						[
							["overview", t("概览", "Overview")],
							["requests", t("请求记录", "Requests")],
							["feedback", t("Bad Case 反馈", "Answer feedback")],
						] as const
					).map(([value, label]) => (
						<button
							key={value}
							type="button"
							aria-pressed={view === value}
							onClick={() => setView(value)}
							className={cn(
								"min-h-11 border-b-2 px-2 text-sm font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-10",
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
				) : view === "feedback" ? (
					<OperationsFeedbackPanel
						key={`${identity.tenantId}:${identity.workspaceId}`}
						workspaceId={identity.workspaceId}
					/>
				) : (
					<div className="min-h-0 flex-1 space-y-6 overflow-y-auto pb-8 md:pr-1 md:[scrollbar-gutter:stable]">
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
							aria-label={t("运行状态", "Operational status")}
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
										? t(
												`${activeAlerts.length} 项活动告警`,
												`${activeAlerts.length} active alerts`,
											)
										: t("告警状态未知", "Alert status unknown")}
								</span>
								<span className="font-mono">
									{snapshot ? formatReleaseVersion(snapshot.release) : "--"}
								</span>
							</div>
						</section>
						<section
							aria-label={t("问答指标", "Ask metrics")}
							className="grid grid-cols-2 divide-y divide-border/60 rounded-lg border border-border bg-card shadow-2xs xl:grid-cols-5 xl:divide-x xl:divide-y-0"
						>
							<MetricCell
								label={t("问答请求", "Ask requests")}
								value={ask ? String(ask.total) : "--"}
								hint={
									ask
										? t(
												`${ask.failed} 失败 · ${ask.cancelled} 取消`,
												`${ask.failed} failed · ${ask.cancelled} canceled`,
											)
										: t("等待统计", "Awaiting statistics")
								}
							/>
							<MetricCell
								label={t("回答完成率", "Answer completion rate")}
								value={terminalAskCount ? percent(successRate) : "--"}
								hint={
									ask
										? t(
												`${ask.completed} 次完成 / ${terminalAskCount} 次终态`,
												`${ask.completed} completed / ${terminalAskCount} terminal`,
											)
										: t("等待统计", "Awaiting statistics")
								}
							/>
							<MetricCell
								label={t("拒答率", "Refusal rate")}
								value={terminalAskCount ? percent(refusalRate) : "--"}
								hint={
									ask
										? t(
												`${ask.refused} 次证据拒答`,
												`${ask.refused} evidence-based refusals`,
											)
										: t("等待统计", "Awaiting statistics")
								}
							/>
							<MetricCell
								label={t("引用覆盖率", "Citation coverage")}
								value={ask?.completed ? percent(citationCoverage) : "--"}
								hint={t(
									"完成回答的引用覆盖",
									"Citation coverage for completed answers",
								)}
							/>
							<MetricCell
								label={t("请求耗时 P95", "P95 request duration")}
								value={latency(ask?.latency_ms.p95 ?? null)}
								hint={`P50 ${latency(ask?.latency_ms.p50 ?? null)}`}
							/>
						</section>
						<div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
							<section
								aria-label={t("问答结果分布", "Ask outcomes")}
								className="min-w-0"
							>
								<div className="flex items-center justify-between border-b border-border py-3">
									<h3 className="text-base font-medium">
										{t("问答结果分布", "Ask outcomes")}
									</h3>
									<TimerReset className="size-4 text-muted-foreground" />
								</div>
								<div className="space-y-4 py-5">
									<SignalBar
										label={t("完成率", "Completion rate")}
										value={successRate}
										tone="cite"
										empty={terminalAskCount === 0}
									/>
									<SignalBar
										label={t("引用覆盖", "Citation coverage")}
										value={citationCoverage}
										tone="cite"
										empty={!ask?.completed}
									/>
									<SignalBar
										label={t("拒答率", "Refusal rate")}
										value={refusalRate}
										tone="survey"
										empty={terminalAskCount === 0}
									/>
									<SignalBar
										label={t("失败率", "Failure rate")}
										value={ask?.total ? ask.failed / ask.total : 0}
										tone="destructive"
										empty={!ask?.total}
									/>
								</div>
							</section>
							<section
								aria-label={t("任务队列", "Job queue")}
								className="min-w-0"
							>
								<div className="flex items-center justify-between border-b border-border py-3">
									<h3 className="text-base font-medium">
										{t("任务队列", "Job queue")}
									</h3>
									<Clock3 className="size-4 text-muted-foreground" />
								</div>
								<dl className="grid grid-cols-3 gap-x-4 gap-y-5 py-5">
									{[
										[t("等待", "Waiting"), jobs?.queued],
										[t("执行", "Running"), jobs?.running],
										[t("终止失败", "Dead"), jobs?.dead],
										[t("超时未推进", "Stalled"), jobs?.stuck],
										[
											t("待恢复删除", "Deletions pending recovery"),
											jobs?.delete_failed,
										],
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
											{t("最老活动任务", "Oldest active job")}
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
								title={t("Ask 阶段延迟", "Ask stage latency")}
								rows={ask?.stage_latency_ms ?? []}
							/>
							<StageLatencyTable
								title={t("入库阶段延迟", "Ingest stage latency")}
								rows={jobs?.stage_latency_ms ?? []}
							/>
						</div>
						<section
							aria-label={t("组件健康", "Component health")}
							className="min-w-0"
						>
							<div className="flex items-center gap-2 border-b border-border py-3">
								<Database className="size-4 text-muted-foreground" />
								<h3 className="text-base font-medium">
									{t("组件健康", "Component health")}
								</h3>
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
													{localizeComponentLabel(
														component.code,
														component.label,
														locale,
													)}
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
														? t("探测已过期", "Probe is stale")
														: component.status === "healthy"
															? component.mode === "configuration"
																? t("配置就绪", "Configuration ready")
																: t("正常", "Healthy")
															: component.status === "degraded"
																? t("异常", "Unhealthy")
																: component.status === "disabled"
																	? t("未启用", "Disabled")
																	: t("未知", "Unknown")}
												</span>
											</div>
											<p className="mt-2 text-xs text-muted-foreground">
												{component.mode === "active"
													? t("主动探测", "Active probe")
													: t("配置检查", "Configuration check")}
												{component.latency_ms == null
													? ""
													: ` · ${formatDurationMs(component.latency_ms)}`}
											</p>
											<p className="mt-1 break-words text-xs text-muted-foreground">
												{t("检查于", "Checked at")}{" "}
												{formatDateTime(component.checked_at)}
											</p>
											{component.status === "degraded" || component.stale ? (
												<p className="mt-2 break-words text-sm text-muted-foreground">
													{localizeComponentRecovery(
														component.code,
														component.error_code,
														component.recovery,
														locale,
													)}
												</p>
											) : null}
										</li>
									))}
								</ul>
							) : (
								<p className="py-5 text-sm text-muted-foreground">
									{t(
										"等待首次健康评估。",
										"Waiting for the first health check.",
									)}
								</p>
							)}
						</section>
						<section
							aria-label={t("活动告警", "Active alerts")}
							className="min-w-0"
						>
							<div className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-3">
								<div className="flex items-center gap-2">
									<BellRing className="size-4 text-muted-foreground" />
									<h3 className="text-base font-medium">
										{t("活动告警", "Active alerts")}
									</h3>
								</div>
								<Link
									href="/app/settings#notifications"
									className="inline-flex min-h-11 items-center text-sm text-evidence underline-offset-4 hover:underline"
								>
									{t("通知设置", "Notification settings")}
								</Link>
							</div>
							<p className="py-3 text-xs text-muted-foreground">
								{snapshot
									? `Webhook ${snapshot.notifications.webhook ? t("已配置", "Configured") : t("未配置", "Not configured")} · ${t("邮件", "Email")} ${snapshot.notifications.email ? t("已配置", "Configured") : t("未配置", "Not configured")}`
									: t("通知配置未知", "Notification configuration unknown")}
							</p>
							{activeAlerts.length ? (
								<ul className="divide-y divide-border/60">
									{activeAlerts.map((alert) => {
										const localizedAlert = localizeAlert(alert, locale);
										return (
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
																? t("严重", "Critical")
																: alert.severity === "warning"
																	? t("警告", "Warning")
																	: t("提示", "Info")}
														</span>
														<h4 className="text-sm font-medium">
															{localizedAlert.title}
														</h4>
													</div>
													<p className="mt-2 break-words text-sm">
														{localizedAlert.detail}
													</p>
													<p className="mt-2 break-words text-xs text-muted-foreground">
														{localizedAlert.recovery}
													</p>
												</div>
												<dl className="space-y-1 text-xs text-muted-foreground">
													<div>
														<dt className="inline">
															{t("首次触发", "First triggered")}{" "}
														</dt>
														<dd className="inline">
															{formatDateTime(alert.first_triggered_at)}
														</dd>
													</div>
													<div>
														<dt className="inline">{t("累计", "Total:")} </dt>
														<dd className="inline tabular-nums">
															{alert.occurrence_count} {t("次", "occurrences")}
														</dd>
													</div>
													<div>
														<dt className="inline">
															{t("投递状态", "Delivery status")}{" "}
														</dt>
														<dd className="inline break-all">
															{alert.last_delivery_status ??
																t("未记录投递", "No delivery recorded")}
														</dd>
													</div>
													{alert.last_delivery_at ? (
														<div>
															<dt className="inline">
																{t("最近投递", "Last delivery")}{" "}
															</dt>
															<dd className="inline">
																{formatDateTime(alert.last_delivery_at)}
															</dd>
														</div>
													) : null}
												</dl>
											</li>
										);
									})}
								</ul>
							) : (
								<p className="py-5 text-sm text-muted-foreground">
									{snapshot
										? t("当前没有活动告警。", "No active alerts.")
										: t(
												"告警数据尚未读取。",
												"Alert data has not been loaded.",
											)}
								</p>
							)}
						</section>
						<section
							aria-label={t("最近错误", "Recent errors")}
							className="min-w-0"
						>
							<div className="flex items-center justify-between border-b border-border py-3">
								<h3 className="text-base font-medium">
									{t("最近错误", "Recent errors")}
								</h3>
								<span className="text-xs text-muted-foreground">
									{t("最多 20 条", "Up to 20")}
								</span>
							</div>
							{snapshot?.recent_errors.length ? (
								<ul className="divide-y divide-border/60">
									{snapshot.recent_errors.map((item) => (
										<li key={`${item.source}-${item.id}`}>
											<button
												type="button"
												aria-label={t(
													`查看${item.source === "ask" ? "请求" : "任务"}错误 ${item.id}`,
													`Inspect ${item.source === "ask" ? "request" : "job"} error ${item.id}`,
												)}
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
														? stageDisplayName(item.stage, locale)
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
									{snapshot
										? t("没有最近错误。", "No recent errors.")
										: t(
												"错误记录尚未读取。",
												"Error data has not been loaded.",
											)}
								</p>
							)}
						</section>
						<details className="group border-t border-border py-2">
							<summary className="flex min-h-11 cursor-pointer list-none items-center justify-between text-sm font-medium">
								{t("服务版本", "Service version")}
								<ChevronDown className="size-4 text-muted-foreground transition-transform duration-150 group-open:rotate-180" />
							</summary>
							<dl className="grid min-w-0 gap-4 py-3 sm:grid-cols-2 xl:grid-cols-4">
								{[
									[
										t("产品版本", "Product version"),
										snapshot ? formatReleaseVersion(snapshot.release) : "--",
									],
									[
										t("提交", "Commit"),
										snapshot?.release.revision_short ?? "--",
									],
									[
										t("构建时间", "Build time"),
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
					</div>
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
