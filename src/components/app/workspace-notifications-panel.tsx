"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, Save, Send, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useSession } from "@/components/app/session-provider";
import {
	type SettingsPanelStateChange,
	useSettingsPanelState,
} from "@/components/app/settings/use-settings-panel-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { useQueryScope } from "@/hooks/use-query-scope";
import { createClientId } from "@/lib/client-id";
import { formatDateTime } from "@/lib/format";
import { useInterfaceText } from "@/lib/i18n/provider";
import { queryKeys } from "@/lib/query-keys";
import {
	type EmailDeliveryView,
	type WorkspaceEmailSettings,
	type WorkspaceNotificationsView,
	workspaceEmailSettingsSchema,
} from "@/lib/workspace-notifications";

type Copy = readonly [zh: string, en: string];
type InterfaceText = ReturnType<typeof useInterfaceText>;

const endpoint = "/api/workspace/notifications";
const SEVERITY_OPTIONS = [
	{ value: "warning", label: ["警告及严重", "Warning and critical"] },
	{ value: "critical", label: ["仅严重", "Critical only"] },
] as const;
const pollWindowMs = 120_000;
const activeStatuses = new Set(["pending", "sending", "retry"]);
const statusLabels: Record<EmailDeliveryView["status"], Copy> = {
	pending: ["等待发送", "Queued"],
	sending: ["正在发送", "Sending"],
	retry: ["等待重试", "Retrying"],
	sent: ["服务商已接受", "Accepted by provider"],
	dead: ["发送失败", "Failed"],
};

const DELIVERY_COLUMNS: readonly Copy[] = [
	["用途", "Purpose"],
	["收件邮箱", "Recipient"],
	["发送状态", "Status"],
	["尝试次数", "Attempts"],
	["时间", "Time"],
	["异常", "Error"],
];

function deliveryError(code: string | null, t: InterfaceText) {
	if (!code) return t("无", "None");
	if (/^email_http_5\d{2}$/.test(code))
		return t("邮件服务暂不可用", "Email service temporarily unavailable");
	switch (code) {
		case "destination_changed":
			return t("旧设置失效，未发送", "Previous settings invalidated; not sent");
		case "transport_unconfigured":
		case "email_not_configured":
			return t("邮件服务未配置", "Email service not configured");
		case "transport_unknown":
			return t(
				"邮件服务状态暂时无法确认",
				"Email service status could not be confirmed",
			);
		case "provider_timeout":
		case "email_timeout":
		case "delivery_timeout":
			return t("邮件服务响应超时", "Email service timed out");
		case "delivery_network_error":
			return t("邮件服务连接异常", "Email service connection error");
		case "email_invalid_response":
			return t("邮件服务响应异常", "Invalid response from email service");
		case "email_request_changed":
			return t(
				"发信内容或配置已变化，本次未重发",
				"Email content or settings changed; not resent",
			);
		case "email_http_409":
			return t(
				"请求幂等冲突，请联系管理员",
				"Idempotency conflict; contact an administrator",
			);
		case "email_concurrent_idempotent_requests":
			return t(
				"服务商正在处理同一请求，稍后重试",
				"Provider is processing the same request; retry later",
			);
		case "email_http_5xx":
			return t("邮件服务暂不可用", "Email service temporarily unavailable");
		case "provider_rate_limited":
		case "email_http_429":
			return t("邮件服务请求过于频繁", "Email service rate limited");
		case "provider_rejected":
		case "email_http_400":
		case "email_http_422":
			return t("邮件服务拒绝了请求", "Email service rejected the request");
		case "email_http_401":
		case "email_http_403":
			return t("邮件服务授权异常", "Email service authorization error");
		default:
			return t("邮件发送异常", "Email delivery error");
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

function requestError(error: unknown, fallback: string, t: InterfaceText) {
	if (error instanceof NotificationRequestError) {
		if (error.status === 401)
			return t(
				"登录已失效，请重新登录",
				"Session expired. Please sign in again.",
			);
		if (error.status === 403)
			return t(
				"当前账号无权管理邮件通知",
				"Your account cannot manage email notifications.",
			);
		if (error.status === 409)
			return t(
				"设置已被其他管理员修改，当前草稿已保留。请刷新后确认。",
				"Settings were updated by another admin. Your draft has been kept—refresh to review.",
			);
		if (error.status === 429)
			return t(
				"测试请求过于频繁，请稍后再试",
				"Too many test requests. Please try again later.",
			);
		if (error.status === 501 || error.status === 503)
			return t(
				"邮件服务暂不可用，请刷新后重试",
				"Email service is temporarily unavailable. Refresh and try again.",
			);
		if (error.status === 400 || error.status === 422)
			return t(
				"设置未被接受，请检查收件邮箱后重试",
				"Settings were not accepted. Check the recipient emails and try again.",
			);
	}
	return fallback;
}

function displayTime(value: string | null, t: InterfaceText) {
	return value && Number.isFinite(Date.parse(value))
		? formatDateTime(value)
		: t("暂无", "N/A");
}

export function WorkspaceNotificationsPanel({
	onStateChange,
}: {
	onStateChange?: SettingsPanelStateChange;
}) {
	const { can, identity } = useSession();
	if (!can("manageMembers")) return null;
	return (
		<NotificationsPanel
			onStateChange={onStateChange}
			key={JSON.stringify([
				identity.tenantId,
				identity.workspaceId,
				identity.principalId,
			])}
		/>
	);
}

function NotificationsPanel({
	onStateChange,
}: {
	onStateChange?: SettingsPanelStateChange;
}) {
	const t = useInterfaceText();
	const severityOptions = SEVERITY_OPTIONS.map((option) => ({
		value: option.value,
		label: t(option.label[0], option.label[1]),
	}));
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
				? t(
						"启用邮件通知前请添加收件邮箱",
						"Add at least one recipient email before enabling notifications.",
					)
				: t(
						"请填写有效的收件邮箱，最多 5 个",
						"Enter up to 5 valid recipient email addresses.",
					)
			: null;

	function handleFailure(cause: unknown, fallback: string) {
		if (lifetime.current?.signal.aborted) return;
		if (cause instanceof NotificationRequestError && cause.status === 409) {
			setError(null);
			setMustRefresh(true);
			return;
		}
		setError(requestError(cause, fallback, t));
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
			setNotice(t("邮件通知设置已保存", "Email notification settings saved."));
		},
		onError: (cause) =>
			handleFailure(
				cause,
				t("保存失败，请稍后重试", "Failed to save. Please try again later."),
			),
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
			setNotice(t("测试邮件已入队", "Test email queued."));
			pollUntil.current = Date.now() + pollWindowMs;
			setAwaitingTest(previousIds);
			void query.refetch({ cancelRefetch: false });
		},
		onError: (cause) =>
			handleFailure(
				cause,
				t(
					"测试邮件未能入队，请稍后重试",
					"Could not queue test email. Please try again later.",
				),
			),
	});
	const busy = save.isPending || test.isPending;
	useSettingsPanelState(onStateChange, { dirty, busy });
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
			id="notifications"
			aria-labelledby={`${id}-heading`}
			className="min-w-0 space-y-6 text-sm"
		>
			<div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 pb-3">
				<h3 id={`${id}-heading`} className="text-base font-medium">
					{t("邮件通知", "Email notifications")}
				</h3>
				<Button
					type="button"
					variant="outline"
					size="icon"
					className="size-11 md:size-9"
					title={t("刷新邮件通知", "Refresh email notifications")}
					aria-label={t("刷新邮件通知", "Refresh email notifications")}
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
					{transport === "configured"
						? t("邮件服务：已配置", "Email service: Configured")
						: transport === "unconfigured"
							? t("邮件服务：未配置", "Email service: Not configured")
							: t("邮件服务：状态未知", "Email service: Status unknown")}
				</span>
				{!unavailable && !transportUnknown ? (
					<span>
						{t("最近检查：", "Last checked: ")}
						{displayTime(view.transport.checked_at, t)}
					</span>
				) : null}
			</div>
			{query.isError ? (
				<p role="alert" className="text-destructive">
					{requestError(
						query.error,
						t(
							"无法加载邮件通知，请刷新重试",
							"Unable to load email notifications. Refresh to try again.",
						),
						t,
					)}
				</p>
			) : null}
			{query.isPending ? (
				<p role="status" className="text-muted-foreground">
					{t("正在加载邮件通知…", "Loading email notifications…")}
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
						className="grid min-w-0 gap-6 md:grid-cols-2 md:gap-8"
					>
						<legend className="sr-only">
							{t("邮件通知设置", "Email notification settings")}
						</legend>
						<div className="min-w-0 space-y-4">
							<label
								htmlFor={`${id}-enabled`}
								className="flex min-h-11 cursor-pointer items-center justify-between gap-3"
							>
								<span>{t("告警邮件通知", "Alert email notifications")}</span>
								<Switch
									id={`${id}-enabled`}
									disabled={busy || unavailable}
									checked={settings.enabled}
									onCheckedChange={(checked) => update({ enabled: checked })}
								/>
							</label>
							<label
								className="flex min-h-11 flex-wrap items-center justify-between gap-3"
								htmlFor={`${id}-severity`}
							>
								<span>{t("最低告警级别", "Minimum severity")}</span>
								<Select
									items={severityOptions}
									value={settings.minimum_severity}
									disabled={busy || unavailable}
									onValueChange={(value) => {
										if (value !== null) update({ minimum_severity: value });
									}}
								>
									<SelectTrigger
										id={`${id}-severity`}
										aria-label={t("最低告警级别", "Minimum severity")}
										className="h-11 w-full min-w-0 md:h-9"
									>
										<SelectValue
											placeholder={
												query.isPending
													? t("加载中…", "Loading…")
													: t("选择告警级别", "Select severity")
											}
										/>
									</SelectTrigger>
									<SelectContent>
										<SelectGroup>
											{severityOptions.map((option) => (
												<SelectItem key={option.value} value={option.value}>
													{option.label}
												</SelectItem>
											))}
										</SelectGroup>
									</SelectContent>
								</Select>
							</label>
							<label
								htmlFor={`${id}-recovery`}
								className="flex min-h-11 cursor-pointer items-center justify-between gap-3"
							>
								<span>{t("恢复时通知", "Notify on recovery")}</span>
								<Switch
									id={`${id}-recovery`}
									disabled={busy || unavailable}
									checked={settings.notify_recovery}
									onCheckedChange={(checked) =>
										update({ notify_recovery: checked })
									}
								/>
							</label>
						</div>
						<div className="min-w-0 space-y-2">
							<div className="flex min-h-11 flex-wrap items-center justify-between gap-3">
								<p>
									{t("收件邮箱", "Recipients")}{" "}
									<span className="text-xs text-muted-foreground">
										{settings.recipients.length}/5
									</span>
								</p>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="size-11 md:size-9"
									title={t("添加收件邮箱", "Add recipient email")}
									aria-label={t("添加收件邮箱", "Add recipient email")}
									disabled={settings.recipients.length >= 5}
									onClick={() =>
										update({ recipients: [...settings.recipients, ""] }, [
											...recipientIds,
											createClientId(),
										])
									}
								>
									<Plus className="size-4" aria-hidden />
								</Button>
							</div>
							{settings.recipients.length === 0 ? (
								<p className="text-xs text-muted-foreground">
									{t("暂无收件邮箱", "No recipient emails")}
								</p>
							) : null}
							{settings.recipients.map((email, index) => (
								<div
									key={recipientIds[index]}
									className="flex min-w-0 items-center gap-2"
								>
									<Input
										type="email"
										aria-label={t(
											`收件邮箱 ${index + 1}`,
											`Recipient email ${index + 1}`,
										)}
										aria-invalid={Boolean(validationError)}
										aria-describedby={
											validationError ? `${id}-recipients-error` : undefined
										}
										value={email}
										maxLength={254}
										autoComplete="off"
										className="h-11 min-w-0 md:h-9"
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
										className="size-11 md:size-9"
										title={t(
											`移除收件邮箱 ${index + 1}`,
											`Remove recipient email ${index + 1}`,
										)}
										aria-label={t(
											`移除收件邮箱 ${index + 1}`,
											`Remove recipient email ${index + 1}`,
										)}
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
								{mustRefresh
									? t(
											"设置已更新，当前草稿已保留。请先刷新。",
											"Settings were updated; your draft has been kept. Please refresh first.",
										)
									: t(
											"设置已更新，当前草稿已保留。请确认要保留的设置。",
											"Settings were updated; your draft has been kept. Choose which settings to keep.",
										)}
							</p>
							{!mustRefresh && view ? (
								<div className="flex flex-wrap gap-2">
									<Button
										type="button"
										variant="outline"
										className="min-h-11 max-w-full whitespace-normal py-2"
										disabled={busy || unavailable || query.isFetching}
										onClick={() => {
											setDraft(null);
											setError(null);
											setNotice(null);
										}}
									>
										{t("使用已保存设置", "Use saved settings")}
									</Button>
									{draft ? (
										<Button
											type="button"
											variant="outline"
											className="min-h-11 max-w-full whitespace-normal py-2"
											disabled={busy || unavailable || query.isFetching}
											onClick={() => {
												setDraft({ ...draft, version: view.version });
												setError(null);
											}}
										>
											{t("确认保留草稿", "Keep my draft")}
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
							{t("可再次测试时间：", "Next test available at: ")}
							{displayTime(new Date(retryAt).toISOString(), t)}
						</p>
					) : null}
					<div className="flex flex-wrap items-center gap-3">
						<Button
							type="submit"
							className="h-11 min-w-36 md:h-9"
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
							{save.isPending
								? t("保存中…", "Saving…")
								: t("保存通知设置", "Save notification settings")}
						</Button>
						<Button
							type="button"
							variant="outline"
							className="h-11 min-w-36 md:h-9"
							disabled={!canTest}
							onClick={() => {
								if (!canTest || !view) return;
								setError(null);
								setNotice(null);
								test.mutate(view.version);
							}}
						>
							<Send className="size-4" aria-hidden />
							{test.isPending
								? t("正在入队…", "Queueing…")
								: t("发送测试邮件", "Send test email")}
						</Button>
						{dirty ? (
							<span className="text-xs text-muted-foreground">
								{t(
									"有未保存的更改，请先保存再测试",
									"You have unsaved changes. Save before sending a test.",
								)}
							</span>
						) : null}
					</div>
				</form>
			) : null}
			<div className="min-w-0 space-y-3 border-t border-border/60 pt-5">
				<h4 className="font-medium">
					{t("最近发送记录", "Recent deliveries")}{" "}
					<span className="text-xs font-normal text-muted-foreground">
						{t("最近 20 条", "Latest 20")}
					</span>
				</h4>
				{!unavailable ? (
					<DeliveryTable deliveries={view.deliveries} />
				) : (
					<p className="text-xs text-muted-foreground">
						{query.isPending
							? t("正在读取发送记录…", "Loading deliveries…")
							: t("发送记录暂不可用", "Delivery records unavailable")}
					</p>
				)}
			</div>
		</section>
	);
}

function DeliveryTable({ deliveries }: { deliveries: EmailDeliveryView[] }) {
	const t = useInterfaceText();
	const recent = [...deliveries]
		.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
		.slice(0, 20);
	return (
		<Table
			className="min-w-[44rem] text-xs"
			containerProps={{
				tabIndex: 0,
				role: "region",
				"aria-label": t("最近邮件发送记录", "Recent email deliveries"),
			}}
		>
			<TableHeader>
				<TableRow>
					{DELIVERY_COLUMNS.map(([zh, en]) => (
						<TableHead key={zh}>{t(zh, en)}</TableHead>
					))}
				</TableRow>
			</TableHeader>
			<TableBody>
				{recent.map((item) => (
					<TableRow key={item.id}>
						<TableCell>
							{item.purpose === "test"
								? t("测试邮件", "Test email")
								: t("告警邮件", "Alert email")}
						</TableCell>
						<TableCell className="min-w-[11rem] max-w-56 whitespace-normal break-all">
							{item.recipient ?? t("未记录", "Not recorded")}
						</TableCell>
						<TableCell>
							{statusLabels[item.status]
								? t(...statusLabels[item.status])
								: t("状态未知", "Status unknown")}
						</TableCell>
						<TableCell className="tabular-nums">
							{item.attempt}/{item.max_attempts}
						</TableCell>
						<TableCell className="space-y-1 text-muted-foreground">
							<p>
								{t("创建：", "Created: ")}
								{displayTime(item.created_at, t)}
							</p>
							{item.status === "sent" ? (
								<p>
									{t("接受：", "Accepted: ")}
									{displayTime(item.delivered_at, t)}
								</p>
							) : item.status === "retry" ? (
								<p>
									{t("重试：", "Retry: ")}
									{displayTime(item.next_attempt_at, t)}
								</p>
							) : null}
						</TableCell>
						<TableCell>{deliveryError(item.error_code, t)}</TableCell>
					</TableRow>
				))}
				{recent.length === 0 ? (
					<TableRow>
						<TableCell
							colSpan={6}
							className="py-6 text-center text-muted-foreground"
						>
							{t("暂无发送记录", "No deliveries yet")}
						</TableCell>
					</TableRow>
				) : null}
			</TableBody>
		</Table>
	);
}
