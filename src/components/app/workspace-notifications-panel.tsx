"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, Plus, RefreshCw, Save, Send, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useSession } from "@/components/app/session-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { useQueryScope } from "@/hooks/use-query-scope";
import { formatDateTime } from "@/lib/format";
import { queryKeys } from "@/lib/query-keys";
import {
	type EmailDeliveryView,
	type WorkspaceEmailSettings,
	type WorkspaceNotificationsView,
	workspaceEmailSettingsSchema,
} from "@/lib/workspace-notifications";

const endpoint = "/api/workspace/notifications";
const pollWindowMs = 120_000;
const activeStatuses = new Set(["pending", "sending", "retry"]);
const statusLabels: Record<EmailDeliveryView["status"], string> = {
	pending: "等待发送",
	sending: "正在发送",
	retry: "等待重试",
	sent: "服务商已接受",
	dead: "发送失败",
};

function deliveryError(code: string | null) {
	if (!code) return "无";
	if (/^email_http_5\d{2}$/.test(code)) return "邮件服务暂不可用";
	switch (code) {
		case "destination_changed":
			return "旧设置失效，未发送";
		case "transport_unconfigured":
		case "email_not_configured":
			return "邮件服务未配置";
		case "transport_unknown":
			return "邮件服务状态暂时无法确认";
		case "provider_timeout":
		case "email_timeout":
		case "delivery_timeout":
			return "邮件服务响应超时";
		case "delivery_network_error":
			return "邮件服务连接异常";
		case "email_invalid_response":
			return "邮件服务响应异常";
		case "email_request_changed":
			return "发信内容或配置已变化，本次未重发";
		case "email_http_409":
			return "请求幂等冲突，请联系管理员";
		case "email_concurrent_idempotent_requests":
			return "服务商正在处理同一请求，稍后重试";
		case "email_http_5xx":
			return "邮件服务暂不可用";
		case "provider_rate_limited":
		case "email_http_429":
			return "邮件服务请求过于频繁";
		case "provider_rejected":
		case "email_http_400":
		case "email_http_422":
			return "邮件服务拒绝了请求";
		case "email_http_401":
		case "email_http_403":
			return "邮件服务授权异常";
		default:
			return "邮件发送异常";
	}
}

class NotificationRequestError extends Error {
	constructor(
		readonly status: number,
		readonly retryAt = 0,
	) {
		super("通知请求失败");
	}
}

async function checkResponse(response: Response) {
	if (response.ok) return;
	const header = response.headers.get("Retry-After");
	const seconds = header ? Number(header) : Number.NaN;
	const parsed = header ? Date.parse(header) : Number.NaN;
	const retryAt = Number.isFinite(seconds)
		? Date.now() + Math.max(0, seconds) * 1000
		: Number.isFinite(parsed)
			? parsed
			: Date.now() + 60_000;
	throw new NotificationRequestError(response.status, retryAt);
}

async function readView(
	response: Response,
): Promise<WorkspaceNotificationsView> {
	await checkResponse(response);
	const view = (await response.json()) as WorkspaceNotificationsView;
	if (
		!view ||
		!Number.isInteger(view.version) ||
		!workspaceEmailSettingsSchema.safeParse(view.settings).success ||
		!Array.isArray(view.deliveries) ||
		!["configured", "unconfigured", "unknown"].includes(view.transport?.status)
	) {
		throw new Error("通知数据暂时不可用");
	}
	return view;
}

function requestError(error: unknown, fallback: string) {
	if (error instanceof NotificationRequestError) {
		if (error.status === 401) return "登录已失效，请重新登录";
		if (error.status === 403) return "当前账号无权管理邮件通知";
		if (error.status === 409)
			return "设置已被其他管理员修改，当前草稿已保留。请刷新后确认。";
		if (error.status === 429) return "测试请求过于频繁，请稍后再试";
		if (error.status === 501 || error.status === 503)
			return "邮件服务暂不可用，请刷新后重试";
		if (error.status === 400 || error.status === 422)
			return "设置未被接受，请检查收件邮箱后重试";
	}
	return fallback;
}

function displayTime(value: string | null) {
	return value && Number.isFinite(Date.parse(value))
		? formatDateTime(value)
		: "暂无";
}

export function WorkspaceNotificationsPanel() {
	const { can, identity } = useSession();
	if (!can("manageMembers")) return null;
	return (
		<NotificationsPanel
			key={JSON.stringify([
				identity.tenantId,
				identity.workspaceId,
				identity.principalId,
			])}
		/>
	);
}

function NotificationsPanel() {
	const scope = useQueryScope();
	const queryClient = useQueryClient();
	const queryKey = queryKeys.workspaceNotifications(scope);
	const id = useId();
	const lifetime = useRef<AbortController | null>(null);
	const pollUntil = useRef(Date.now() + pollWindowMs);
	const [awaitingTest, setAwaitingTest] = useState<Set<string> | null>(null);
	const [draft, setDraft] = useState<{
		settings: WorkspaceEmailSettings;
		version: number;
		recipientIds: string[];
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [mustRefresh, setMustRefresh] = useState(false);
	const [transportUnknown, setTransportUnknown] = useState(false);
	const [retryAt, setRetryAt] = useState(0);

	useEffect(() => {
		lifetime.current = new AbortController();
		return () => lifetime.current?.abort();
	}, []);

	useEffect(() => {
		if (!retryAt) return;
		const timer = setTimeout(
			() => setRetryAt(0),
			Math.min(Math.max(0, retryAt - Date.now()), 2_147_483_647),
		);
		return () => clearTimeout(timer);
	}, [retryAt]);

	const query = useQuery({
		queryKey,
		queryFn: async ({ signal }) =>
			readView(await fetch(endpoint, { cache: "no-store", signal })),
		retry: false,
		staleTime: 0,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		refetchIntervalInBackground: false,
		refetchInterval: (current) => {
			if (current.state.status === "error" || Date.now() >= pollUntil.current)
				return false;
			const deliveries = current.state.data?.deliveries ?? [];
			const waitingForTest =
				awaitingTest &&
				!deliveries.some(
					(item) => item.purpose === "test" && !awaitingTest.has(item.id),
				);
			return waitingForTest ||
				deliveries.some((item) => activeStatuses.has(item.status))
				? 3000
				: false;
		},
	});
	const view = query.data;
	const settings = draft?.settings ?? view?.settings;
	const recipientIds = draft?.recipientIds ?? view?.settings.recipients ?? [];
	const dirty = Boolean(
		draft && JSON.stringify(draft.settings) !== JSON.stringify(view?.settings),
	);
	const versionChanged = Boolean(
		draft && view && draft.version !== view.version,
	);
	const conflict = mustRefresh || versionChanged;
	const validation = settings
		? workspaceEmailSettingsSchema.safeParse({
				...settings,
				recipients: settings.recipients.map((email) => email.trim()),
			})
		: null;
	const validationError =
		validation && !validation.success
			? settings?.enabled && settings.recipients.length === 0
				? "启用邮件通知前请添加收件邮箱"
				: "请填写有效的收件邮箱，最多 5 个"
			: null;

	function handleFailure(cause: unknown, fallback: string) {
		if (lifetime.current?.signal.aborted) return;
		if (cause instanceof NotificationRequestError && cause.status === 409) {
			setError(null);
			setMustRefresh(true);
			return;
		}
		setError(requestError(cause, fallback));
		if (cause instanceof NotificationRequestError) {
			if (cause.status === 429) setRetryAt(cause.retryAt);
			if (cause.status === 501 || cause.status === 503)
				setTransportUnknown(true);
		}
	}

	const save = useMutation({
		mutationFn: async (payload: {
			version: number;
			settings: WorkspaceEmailSettings;
		}) => {
			await queryClient.cancelQueries({ queryKey, exact: true });
			return readView(
				await fetch(endpoint, {
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload),
					signal: lifetime.current?.signal,
				}),
			);
		},
		retry: false,
		onSuccess: async (saved) => {
			await queryClient.cancelQueries({ queryKey, exact: true });
			if (lifetime.current?.signal.aborted) return;
			queryClient.setQueryData(queryKey, saved);
			setDraft(null);
			setMustRefresh(false);
			setTransportUnknown(false);
			setNotice("邮件通知设置已保存");
		},
		onError: (cause) => handleFailure(cause, "保存失败，请稍后重试"),
	});

	const test = useMutation({
		onMutate: () => new Set(view?.deliveries.map((item) => item.id)),
		mutationFn: async (version: number) => {
			const response = await fetch(`${endpoint}/test`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ version }),
				signal: lifetime.current?.signal,
			});
			await checkResponse(response);
			const result = (await response.json()) as { queued: number };
			if (
				response.status !== 202 ||
				!Number.isInteger(result.queued) ||
				result.queued < 1
			)
				throw new Error("测试未入队");
			return result;
		},
		retry: false,
		onSuccess: (_result, _version, previousIds) => {
			if (lifetime.current?.signal.aborted) return;
			setNotice("测试邮件已入队");
			pollUntil.current = Date.now() + pollWindowMs;
			setAwaitingTest(previousIds);
			void query.refetch({ cancelRefetch: false });
		},
		onError: (cause) => handleFailure(cause, "测试邮件未能入队，请稍后重试"),
	});
	const busy = save.isPending || test.isPending;
	const unavailable = !view || query.isError;
	const transport =
		unavailable || transportUnknown ? "unknown" : view.transport.status;
	const canTest =
		!unavailable &&
		!busy &&
		!query.isFetching &&
		!dirty &&
		!conflict &&
		transport === "configured" &&
		Boolean(view.settings.recipients.length) &&
		!retryAt;
	function update(patch: Partial<WorkspaceEmailSettings>, ids = recipientIds) {
		if (!settings || !view || busy || unavailable) return;
		setDraft({
			settings: { ...settings, ...patch },
			version: draft?.version ?? view.version,
			recipientIds: ids,
		});
		setNotice(null);
		setError(null);
	}

	async function refresh() {
		setError(null);
		pollUntil.current = Date.now() + pollWindowMs;
		const result = await query.refetch();
		if (lifetime.current?.signal.aborted || result.isError) return;
		setMustRefresh(false);
		setTransportUnknown(false);
	}

	return (
		<section
			aria-labelledby={`${id}-heading`}
			className="min-w-0 space-y-5 border-t border-border/70 pt-6 text-sm"
		>
			<div className="flex items-center justify-between gap-3">
				<h3
					id={`${id}-heading`}
					className="flex items-center gap-2 font-heading text-lg font-semibold"
				>
					<Mail className="size-4 text-muted-foreground" aria-hidden />
					邮件通知
				</h3>
				<Button
					type="button"
					variant="outline"
					size="icon"
					title="刷新邮件通知"
					aria-label="刷新邮件通知"
					disabled={busy || query.isFetching}
					onClick={() => void refresh()}
				>
					<RefreshCw className="size-4" aria-hidden />
				</Button>
			</div>
			<div
				className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground"
				role="status"
			>
				<span>
					邮件服务：
					{transport === "configured"
						? "已配置"
						: transport === "unconfigured"
							? "未配置"
							: "状态未知"}
				</span>
				{!unavailable && !transportUnknown ? (
					<span>最近检查：{displayTime(view.transport.checked_at)}</span>
				) : null}
			</div>
			{query.isError ? (
				<p role="alert" className="text-destructive">
					{requestError(query.error, "无法加载邮件通知，请刷新重试")}
				</p>
			) : null}
			{query.isPending ? (
				<p role="status" className="text-muted-foreground">
					正在加载邮件通知…
				</p>
			) : null}
			{settings ? (
				<form
					noValidate
					className="space-y-5"
					onSubmit={(event) => {
						event.preventDefault();
						if (
							!validation?.success ||
							!view ||
							busy ||
							unavailable ||
							!dirty ||
							conflict ||
							query.isFetching
						)
							return;
						setError(null);
						setNotice(null);
						save.mutate({
							version: draft?.version ?? view.version,
							settings: validation.data,
						});
					}}
				>
					<fieldset
						disabled={busy || unavailable}
						className="grid min-w-0 gap-6 md:grid-cols-2"
					>
						<legend className="sr-only">邮件通知设置</legend>
						<div className="space-y-4">
							<label className="flex min-h-9 cursor-pointer items-center justify-between gap-3">
								<span>告警邮件通知</span>
								<input
									type="checkbox"
									className="size-4 accent-primary"
									checked={settings.enabled}
									onChange={(event) =>
										update({ enabled: event.target.checked })
									}
								/>
							</label>
							<label
								className="flex flex-wrap items-center justify-between gap-3"
								htmlFor={`${id}-severity`}
							>
								<span>最低告警级别</span>
								<select
									id={`${id}-severity`}
									className="h-9 max-w-full rounded-md border border-input bg-background px-2 text-sm"
									value={settings.minimum_severity}
									onChange={(event) =>
										update({
											minimum_severity: event.target
												.value as WorkspaceEmailSettings["minimum_severity"],
										})
									}
								>
									<option value="warning">警告及严重</option>
									<option value="critical">仅严重</option>
								</select>
							</label>
							<label className="flex min-h-9 cursor-pointer items-center justify-between gap-3">
								<span>恢复时通知</span>
								<input
									type="checkbox"
									className="size-4 accent-primary"
									checked={settings.notify_recovery}
									onChange={(event) =>
										update({ notify_recovery: event.target.checked })
									}
								/>
							</label>
						</div>
						<div className="min-w-0 space-y-2">
							<div className="flex min-h-9 items-center justify-between gap-3">
								<p>
									收件邮箱{" "}
									<span className="text-xs text-muted-foreground">
										{settings.recipients.length}/5
									</span>
								</p>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									title="添加收件邮箱"
									aria-label="添加收件邮箱"
									disabled={settings.recipients.length >= 5}
									onClick={() =>
										update({ recipients: [...settings.recipients, ""] }, [
											...recipientIds,
											crypto.randomUUID(),
										])
									}
								>
									<Plus className="size-4" aria-hidden />
								</Button>
							</div>
							{settings.recipients.length === 0 ? (
								<p className="text-xs text-muted-foreground">暂无收件邮箱</p>
							) : null}
							{settings.recipients.map((email, index) => (
								<div
									key={recipientIds[index]}
									className="flex min-w-0 items-center gap-2"
								>
									<Input
										type="email"
										aria-label={`收件邮箱 ${index + 1}`}
										aria-invalid={Boolean(validationError)}
										aria-describedby={
											validationError ? `${id}-recipients-error` : undefined
										}
										value={email}
										maxLength={254}
										autoComplete="off"
										className="h-9"
										onChange={(event) =>
											update({
												recipients: settings.recipients.map(
													(value, position) =>
														position === index ? event.target.value : value,
												),
											})
										}
									/>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										title={`移除收件邮箱 ${index + 1}`}
										aria-label={`移除收件邮箱 ${index + 1}`}
										onClick={() =>
											update(
												{
													recipients: settings.recipients.filter(
														(_, position) => position !== index,
													),
												},
												recipientIds.filter(
													(_, position) => position !== index,
												),
											)
										}
									>
										<X className="size-4" aria-hidden />
									</Button>
								</div>
							))}
							{validationError ? (
								<p
									id={`${id}-recipients-error`}
									role="alert"
									className="text-xs text-destructive"
								>
									{validationError}
								</p>
							) : null}
						</div>
					</fieldset>
					{conflict ? (
						<div
							role="alert"
							className="space-y-3 border-y border-border/70 py-3"
						>
							<p>
								设置已更新，当前草稿已保留。
								{mustRefresh ? "请先刷新。" : "请确认要保留的设置。"}
							</p>
							{!mustRefresh && view ? (
								<div className="flex flex-wrap gap-2">
									<Button
										type="button"
										variant="outline"
										disabled={busy || unavailable || query.isFetching}
										onClick={() => {
											setDraft(null);
											setError(null);
											setNotice(null);
										}}
									>
										使用已保存设置
									</Button>
									{draft ? (
										<Button
											type="button"
											variant="outline"
											disabled={busy || unavailable || query.isFetching}
											onClick={() => {
												setDraft({ ...draft, version: view.version });
												setError(null);
											}}
										>
											确认保留草稿
										</Button>
									) : null}
								</div>
							) : null}
						</div>
					) : null}
					{error ? (
						<p role="alert" className="text-destructive">
							{error}
						</p>
					) : null}
					{notice ? (
						<p role="status" className="text-muted-foreground">
							{notice}
						</p>
					) : null}
					{retryAt ? (
						<p className="text-xs text-muted-foreground">
							可再次测试时间：{displayTime(new Date(retryAt).toISOString())}
						</p>
					) : null}
					<div className="flex flex-wrap items-center gap-3">
						<Button
							type="submit"
							disabled={
								busy ||
								unavailable ||
								query.isFetching ||
								!dirty ||
								conflict ||
								!validation?.success
							}
						>
							<Save className="size-4" aria-hidden />
							{save.isPending ? "保存中…" : "保存通知设置"}
						</Button>
						<Button
							type="button"
							variant="outline"
							disabled={!canTest}
							onClick={() => {
								if (!canTest || !view) return;
								setError(null);
								setNotice(null);
								test.mutate(view.version);
							}}
						>
							<Send className="size-4" aria-hidden />
							{test.isPending ? "正在入队…" : "发送测试邮件"}
						</Button>
						{dirty ? (
							<span className="text-xs text-muted-foreground">
								有未保存的更改，请先保存再测试
							</span>
						) : null}
					</div>
				</form>
			) : null}
			<div className="min-w-0 space-y-3 border-t border-border/60 pt-5">
				<h4 className="font-medium">
					最近发送记录{" "}
					<span className="text-xs font-normal text-muted-foreground">
						最近 20 条
					</span>
				</h4>
				{!unavailable ? (
					<DeliveryTable deliveries={view.deliveries} />
				) : (
					<p className="text-xs text-muted-foreground">
						{query.isPending ? "正在读取发送记录…" : "发送记录暂不可用"}
					</p>
				)}
			</div>
		</section>
	);
}

function DeliveryTable({ deliveries }: { deliveries: EmailDeliveryView[] }) {
	const recent = [...deliveries]
		.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
		.slice(0, 20);
	return (
		<Table className="min-w-[44rem] text-xs">
			<TableHeader>
				<TableRow>
					{["用途", "收件邮箱", "发送状态", "尝试次数", "时间", "异常"].map(
						(label) => (
							<TableHead key={label}>{label}</TableHead>
						),
					)}
				</TableRow>
			</TableHeader>
			<TableBody>
				{recent.map((item) => (
					<TableRow key={item.id}>
						<TableCell>
							{item.purpose === "test" ? "测试邮件" : "告警邮件"}
						</TableCell>
						<TableCell className="min-w-[11rem] max-w-56 whitespace-normal break-all">
							{item.recipient ?? "未记录"}
						</TableCell>
						<TableCell>{statusLabels[item.status] ?? "状态未知"}</TableCell>
						<TableCell className="tabular-nums">
							{item.attempt}/{item.max_attempts}
						</TableCell>
						<TableCell className="space-y-1 text-muted-foreground">
							<p>创建：{displayTime(item.created_at)}</p>
							{item.status === "sent" ? (
								<p>接受：{displayTime(item.delivered_at)}</p>
							) : item.status === "retry" ? (
								<p>重试：{displayTime(item.next_attempt_at)}</p>
							) : null}
						</TableCell>
						<TableCell>{deliveryError(item.error_code)}</TableCell>
					</TableRow>
				))}
				{recent.length === 0 ? (
					<TableRow>
						<TableCell
							colSpan={6}
							className="py-6 text-center text-muted-foreground"
						>
							暂无发送记录
						</TableCell>
					</TableRow>
				) : null}
			</TableBody>
		</Table>
	);
}
