"use client";

import { RefreshCw, Save } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { HelpTip } from "@/components/app/help-tip";
import { useSession } from "@/components/app/session-provider";
import {
	type SettingsPanelStateChange,
	useSettingsPanelState,
} from "@/components/app/settings/use-settings-panel-state";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useInterfaceText } from "@/lib/i18n/provider";

type AskSettings = {
	answer_profile: "precise" | "balanced" | "exploratory";
	reranking: "auto" | "on" | "off";
	session_memory_enabled: boolean;
};

type FieldKey = keyof AskSettings;
type Copy = readonly [zh: string, en: string];

const FIELDS: {
	key: FieldKey;
	label: Copy;
	tip: Copy;
	kind: "enum" | "bool";
	options?: { value: string; label: Copy }[];
}[] = [
	{
		key: "answer_profile",
		label: ["回答模式", "Answer mode"],
		kind: "enum",
		tip: [
			"统一调节检索召回范围与引用拒答严谨度：精确模式更保守，探索模式扩大覆盖面。所有模式均要求充分证据。",
			"Controls retrieval breadth and citation strictness: precise is more conservative; exploratory broadens coverage. All modes require grounded evidence.",
		],
		options: [
			{ value: "precise", label: ["精确", "Precise"] },
			{ value: "balanced", label: ["均衡", "Balanced"] },
			{ value: "exploratory", label: ["探索", "Exploratory"] },
		],
	},
	{
		key: "reranking",
		label: ["检索精排", "Retrieval reranking"],
		kind: "enum",
		tip: [
			"底座默认启用 Qdrant 混合检索（Dense + Sparse RRF）。精排支持自动（对比、精确编号、多轮改写、sparse-only 命中及重试自动精排）、始终开启或关闭。",
			"Qdrant hybrid retrieval (Dense + Sparse RRF) stays enabled by default. Reranking can be Auto (complex/rewritten/sparse-only/retry), always On, or Off.",
		],
		options: [
			{ value: "auto", label: ["自动", "Auto"] },
			{ value: "on", label: ["开启", "On"] },
			{ value: "off", label: ["关闭", "Off"] },
		],
	},
	{
		key: "session_memory_enabled",
		label: ["对话记忆", "Conversation memory"],
		kind: "bool",
		tip: [
			"多轮追问时保留当前会话的短上下文。",
			"Keep short-term context for follow-up questions in this conversation.",
		],
	},
];

function formatDefault(
	key: FieldKey,
	defaults: AskSettings | null,
	t: ReturnType<typeof useInterfaceText>,
): string {
	if (!defaults) return "—";
	const value = defaults[key];
	if (typeof value === "boolean") return value ? t("开", "On") : t("关", "Off");
	const field = FIELDS.find((item) => item.key === key);
	const option = field?.options?.find((item) => item.value === value);
	return option ? t(...option.label) : String(value);
}

export function WorkspaceAskSettingsPanel({
	onStateChange,
}: {
	onStateChange?: SettingsPanelStateChange;
}) {
	const t = useInterfaceText();
	const id = useId();
	const { can } = useSession();
	const sessionCanManage = can("manageMembers");
	const [serverCanManage, setServerCanManage] = useState<boolean | null>(null);
	const canManage = sessionCanManage && serverCanManage === true;
	const [ask, setAsk] = useState<AskSettings | null>(null);
	const [defaults, setDefaults] = useState<AskSettings | null>(null);
	const [draft, setDraft] = useState<AskSettings | null>(null);
	const [policyVersion, setPolicyVersion] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [conflict, setConflict] = useState(false);
	const [saved, setSaved] = useState(false);
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(true);
	const dirty = Boolean(
		ask && draft && FIELDS.some(({ key }) => ask[key] !== draft[key]),
	);
	useSettingsPanelState(onStateChange, { dirty, busy });

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		setConflict(false);
		try {
			const response = await fetch("/api/workspace/settings");
			if (!response.ok) {
				setError("load_failed");
				return;
			}
			const data = (await response.json()) as {
				can_manage?: boolean;
				ask: AskSettings;
				defaults: AskSettings;
				policy_version?: number;
			};
			setServerCanManage(
				typeof data.can_manage === "boolean" ? data.can_manage : null,
			);
			setAsk(data.ask);
			setDraft(data.ask);
			setDefaults(data.defaults);
			setPolicyVersion(
				typeof data.policy_version === "number" ? data.policy_version : null,
			);
		} catch {
			setError("load_failed");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	function setField<K extends FieldKey>(key: K, value: AskSettings[K]) {
		setSaved(false);
		setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
	}

	async function save() {
		if (!canManage || !ask || !draft || busy || loading) return;
		setBusy(true);
		setError(null);
		setConflict(false);
		setSaved(false);

		const patch: Partial<AskSettings> = {};
		for (const field of FIELDS) {
			const key = field.key;
			if (draft[key] !== ask[key]) {
				(patch as Record<string, unknown>)[key] = draft[key];
			}
		}

		if (Object.keys(patch).length === 0) {
			setBusy(false);
			setSaved(true);
			return;
		}

		try {
			const response = await fetch("/api/workspace/settings", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					ask: patch,
					...(policyVersion != null ? { policy_version: policyVersion } : {}),
				}),
			});
			if (!response.ok) {
				if (response.status === 403) setServerCanManage(false);
				if (response.status === 409) {
					setConflict(true);
					setError("version_conflict");
					return;
				}
				const detail = await response.json().catch(() => null);
				setError(
					typeof detail?.detail === "string"
						? detail.detail
						: t("保存失败", "Couldn't save"),
				);
				return;
			}
			const data = (await response.json()) as {
				can_manage?: boolean;
				ask: AskSettings;
				defaults: AskSettings;
				policy_version?: number;
			};
			setServerCanManage(
				typeof data.can_manage === "boolean" ? data.can_manage : null,
			);
			setAsk(data.ask);
			setDraft(data.ask);
			setDefaults(data.defaults);
			setPolicyVersion(
				typeof data.policy_version === "number" ? data.policy_version : null,
			);
			setSaved(true);
		} catch {
			setError(t("保存失败，请重试", "Couldn't save. Try again."));
		} finally {
			setBusy(false);
		}
	}

	if (loading && !defaults) {
		return (
			<section
				id="ask-settings"
				aria-labelledby={`${id}-heading`}
				className="min-w-0 space-y-6 text-sm"
			>
				<h3
					id={`${id}-heading`}
					className="border-b border-border/70 pb-3 text-base font-medium"
				>
					{t("问答策略", "Ask policy")}
				</h3>
				<p role="status" className="text-muted-foreground">
					{t("加载中…", "Loading…")}
				</p>
			</section>
		);
	}

	return (
		<section
			id="ask-settings"
			aria-labelledby={`${id}-heading`}
			className="min-w-0 space-y-6 text-sm"
		>
			<div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/70 pb-3">
				<h3 id={`${id}-heading`} className="text-base font-medium">
					{t("问答策略", "Ask policy")}
				</h3>
				<div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
					{!canManage ? (
						<span>
							{!sessionCanManage || serverCanManage === false
								? t(
										"只读 · 需管理员权限修改",
										"Read only · Administrator access required to edit",
									)
								: t("权限状态未确认", "Permissions not yet confirmed")}
						</span>
					) : null}
					{policyVersion != null ? (
						<span>
							{t("策略版本", "Policy version")} {policyVersion}
						</span>
					) : null}
				</div>
			</div>

			<ul className="divide-y divide-border/60">
				{FIELDS.map((field) => {
					const value = draft?.[field.key];
					const label = t(...field.label);
					const options =
						field.options?.map(({ value, label }) => ({
							value,
							label: t(...label),
						})) ?? [];
					return (
						<li
							key={field.key}
							className="flex min-w-0 flex-wrap items-center justify-between gap-x-8 gap-y-3 py-4 first:pt-0"
						>
							<div className="min-w-[min(100%,14rem)] max-w-xl flex-1">
								<div className="flex items-center gap-1">
									<label htmlFor={`${id}-${field.key}`} className="font-medium">
										{label}
									</label>
									<HelpTip label={label}>
										{t(...field.tip)}
										<span className="mt-2 block">
											{t("默认：", "Default:")}
											{formatDefault(field.key, defaults, t)}
										</span>
									</HelpTip>
								</div>
								<p className="mt-1 text-xs leading-relaxed text-muted-foreground">
									{t(...field.tip)}
								</p>
							</div>
							<div className="w-full shrink-0 sm:w-56">
								{field.kind === "bool" ? (
									<div className="flex min-h-11 items-center sm:min-h-9 sm:justify-end">
										<label
											htmlFor={`${id}-${field.key}`}
											className="inline-flex cursor-pointer items-center gap-3"
										>
											<Switch
												id={`${id}-${field.key}`}
												aria-label={label}
												disabled={
													!canManage || value == null || busy || loading
												}
												checked={Boolean(value)}
												onCheckedChange={(checked) => {
													setField("session_memory_enabled", checked);
												}}
											/>
										</label>
									</div>
								) : (
									<Select
										items={options}
										disabled={!canManage || value == null || busy || loading}
										value={typeof value === "string" ? value : null}
										onValueChange={(nextValue) => {
											if (nextValue === null) return;
											setField(
												field.key,
												nextValue as AskSettings[typeof field.key],
											);
										}}
									>
										<SelectTrigger
											id={`${id}-${field.key}`}
											aria-label={label}
											className="h-11 w-full min-w-0 md:h-9"
										>
											<SelectValue
												placeholder={
													loading
														? t("加载中…", "Loading…")
														: t("请选择", "Select an option")
												}
											/>
										</SelectTrigger>
										<SelectContent>
											<SelectGroup>
												{options.map((option) => (
													<SelectItem key={option.value} value={option.value}>
														{option.label}
													</SelectItem>
												))}
											</SelectGroup>
										</SelectContent>
									</Select>
								)}
							</div>
						</li>
					);
				})}
			</ul>

			{error || saved || (error && !ask) || canManage ? (
				<div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-4">
					<div className="min-w-0 space-y-1">
						{error ? (
							<p role="alert" className="text-sm text-destructive">
								{error === "load_failed"
									? t("无法加载工作区设置", "Couldn't load workspace settings")
									: error === "version_conflict"
										? t(
												"问答策略已被其他管理员更新，请刷新最新设置后重试。",
												"Ask policy was updated by another administrator. Refresh to load the latest settings and try again.",
											)
										: error}
							</p>
						) : null}
						{saved ? (
							<p role="status" className="text-sm text-muted-foreground">
								{t("已保存", "Saved")}
							</p>
						) : !error && canManage ? (
							<p className="text-xs text-muted-foreground">
								{dirty
									? t("有未保存的策略更改", "You have unsaved policy changes")
									: t(
											"更改将在保存后立即应用于新问答",
											"Changes apply to new questions once saved",
										)}
							</p>
						) : null}
					</div>
					<div className="flex items-center gap-2">
						{(error && !ask) || conflict ? (
							<Button
								type="button"
								className="h-11 min-w-24 md:h-9"
								variant="outline"
								disabled={loading || busy}
								onClick={() => void refresh()}
							>
								<RefreshCw className="size-4" aria-hidden />
								{conflict
									? t("刷新最新设置", "Refresh settings")
									: t("重试", "Retry")}
							</Button>
						) : null}
						{canManage ? (
							<Button
								type="button"
								className="h-11 min-w-28"
								disabled={busy || loading || !ask || !draft || !dirty}
								onClick={() => void save()}
							>
								<Save className="size-4" aria-hidden />
								{busy ? t("保存中…", "Saving…") : t("保存", "Save")}
							</Button>
						) : null}
					</div>
				</div>
			) : null}
		</section>
	);
}
