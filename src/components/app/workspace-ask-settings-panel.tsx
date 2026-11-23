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
	retrieval_enhancement: "auto" | "off" | "on";
	hybrid_retrieval: "inherit" | "off" | "on";
	reranking: "inherit" | "off" | "on";
	session_memory_enabled: boolean;
	evidence_requirement: "strict" | "standard" | "relaxed";
};

type FieldKey = keyof AskSettings;
type Copy = readonly [zh: string, en: string];

const RETRIEVAL_OPTIONS = [
	{ value: "inherit", label: ["跟随检索增强", "Follow policy"] },
	{ value: "on", label: ["开启", "On"] },
	{ value: "off", label: ["关闭", "Off"] },
] satisfies { value: string; label: Copy }[];

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
			"精确模式更保守；探索模式扩大检索范围。所有模式都需要证据支持回答。",
			"Precise mode is more conservative; exploratory mode broadens retrieval. All modes require evidence.",
		],
		options: [
			{ value: "precise", label: ["精确", "Precise"] },
			{ value: "balanced", label: ["均衡", "Balanced"] },
			{ value: "exploratory", label: ["探索", "Exploratory"] },
		],
	},
	{
		key: "retrieval_enhancement",
		label: ["检索增强", "Retrieval enhancement"],
		kind: "enum",
		tip: [
			"自动模式默认启用混合检索，并按问题决定是否重排。混合检索和重排可单独设置。",
			"Auto uses hybrid retrieval by default and decides whether to rerank based on the question. Hybrid retrieval and reranking can be set independently.",
		],
		options: [
			{ value: "auto", label: ["自动", "Auto"] },
			{ value: "off", label: ["关闭", "Off"] },
			{ value: "on", label: ["开启", "On"] },
		],
	},
	{
		key: "hybrid_retrieval",
		label: ["混合检索", "Hybrid retrieval"],
		kind: "enum",
		tip: [
			"结合关键词与向量搜索查找证据。",
			"Find evidence using keyword and vector search.",
		],
		options: RETRIEVAL_OPTIONS,
	},
	{
		key: "reranking",
		label: ["检索重排", "Reranking"],
		kind: "enum",
		tip: [
			"使用部署配置的重排模型重新排列候选片段。",
			"Reorder results using the deployment’s reranking model.",
		],
		options: RETRIEVAL_OPTIONS,
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
	{
		key: "evidence_requirement",
		label: ["证据要求", "Evidence requirement"],
		kind: "enum",
		tip: [
			"严格/标准/宽松，调节拒答与引用裁决；与回答模式冲突时取更严一侧。",
			"Adjust refusal and citation strictness. If this conflicts with the answer mode, the stricter setting wins.",
		],
		options: [
			{ value: "strict", label: ["严格", "Strict"] },
			{ value: "standard", label: ["标准", "Standard"] },
			{ value: "relaxed", label: ["宽松", "Relaxed"] },
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
				body: JSON.stringify({ ask: patch }),
			});
			if (!response.ok) {
				if (response.status === 403) setServerCanManage(false);
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
				<h3 id={`${id}-heading`} className="text-xl font-medium">
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
							className="flex min-w-0 flex-col gap-3 py-4 first:pt-0 sm:flex-row sm:items-center sm:justify-between sm:gap-8"
						>
							<div className="min-w-0 max-w-xl flex-1">
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
						{error && !ask ? (
							<Button
								type="button"
								className="h-11 min-w-24 md:h-9"
								variant="outline"
								disabled={loading}
								onClick={() => void refresh()}
							>
								<RefreshCw className="size-4" aria-hidden />
								{t("重试", "Retry")}
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
