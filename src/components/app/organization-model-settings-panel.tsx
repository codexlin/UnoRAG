"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertTriangle,
	CheckCircle2,
	KeyRound,
	Lock,
	PlugZap,
	RefreshCw,
	RotateCcw,
	Save,
	Sparkles,
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSession } from "@/components/app/session-provider";
import {
	type SettingsPanelStateChange,
	useSettingsPanelState,
} from "@/components/app/settings/use-settings-panel-state";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useQueryScope } from "@/hooks/use-query-scope";
import { formatDateTime } from "@/lib/format";
import { useInterfaceText } from "@/lib/i18n/provider";
import type {
	ModelConnectionTestResult,
	ModelSlot,
	ModelSlotSource,
	OrganizationModelPatch,
	OrganizationModelSettingsView,
} from "@/lib/model-settings";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

type Copy = readonly [zh: string, en: string];
type InterfaceText = ReturnType<typeof useInterfaceText>;

type DraftState = {
	chat: {
		base_url: string;
		model: string;
		supports_structured_outputs: boolean;
		include_usage: boolean;
		api_key: string;
		clear_api_key: boolean;
	};
	judge: {
		inherit_chat: boolean;
		base_url: string;
		model: string;
		supports_structured_outputs: boolean;
		api_key: string;
		clear_api_key: boolean;
	};
	rerank: {
		base_url: string;
		model: string;
		api_key: string;
		clear_api_key: boolean;
	};
	vlm: {
		enabled: boolean;
		base_url: string;
		model: string;
		api_key: string;
		clear_api_key: boolean;
	};
};

const ENDPOINT = "/api/organization/model-settings";
const TEST_ENDPOINT = "/api/organization/model-settings/test";

const SOURCE_LABELS: Record<ModelSlotSource, Copy> = {
	database: ["在线覆盖", "UI override"],
	env: ["环境变量", "Environment"],
	inherited: ["复用主对话", "Inherits Chat"],
	disabled: ["未启用", "Disabled"],
};

function draftFromView(view: OrganizationModelSettingsView): DraftState {
	return {
		chat: {
			base_url: view.slots.chat.base_url,
			model: view.slots.chat.model,
			supports_structured_outputs: view.slots.chat.supports_structured_outputs,
			include_usage: view.slots.chat.include_usage,
			api_key: "",
			clear_api_key: false,
		},
		judge: {
			inherit_chat: view.slots.judge.inherit_chat,
			base_url: view.slots.judge.base_url,
			model: view.slots.judge.model,
			supports_structured_outputs: view.slots.judge.supports_structured_outputs,
			api_key: "",
			clear_api_key: false,
		},
		rerank: {
			base_url: view.slots.rerank.base_url ?? "",
			model: view.slots.rerank.model,
			api_key: "",
			clear_api_key: false,
		},
		vlm: {
			enabled: view.slots.vlm.enabled,
			base_url: view.slots.vlm.base_url ?? "",
			model: view.slots.vlm.model ?? "",
			api_key: "",
			clear_api_key: false,
		},
	};
}

function buildPatchFromDraft(
	draft: DraftState,
	view: OrganizationModelSettingsView,
): OrganizationModelPatch {
	const patch: OrganizationModelPatch = {};

	const chatChanged =
		draft.chat.base_url.trim() !== view.slots.chat.base_url ||
		draft.chat.model.trim() !== view.slots.chat.model ||
		draft.chat.supports_structured_outputs !==
			view.slots.chat.supports_structured_outputs ||
		draft.chat.include_usage !== view.slots.chat.include_usage ||
		Boolean(draft.chat.api_key.trim()) ||
		draft.chat.clear_api_key;
	if (chatChanged) {
		patch.chat = {
			base_url: draft.chat.base_url.trim() || null,
			model: draft.chat.model.trim() || null,
			supports_structured_outputs: draft.chat.supports_structured_outputs,
			include_usage: draft.chat.include_usage,
			...(draft.chat.api_key.trim()
				? { api_key: draft.chat.api_key.trim() }
				: {}),
			...(draft.chat.clear_api_key ? { clear_api_key: true } : {}),
		};
	}

	const judgeChanged =
		draft.judge.inherit_chat !== view.slots.judge.inherit_chat ||
		(!draft.judge.inherit_chat &&
			(draft.judge.base_url.trim() !== view.slots.judge.base_url ||
				draft.judge.model.trim() !== view.slots.judge.model ||
				draft.judge.supports_structured_outputs !==
					view.slots.judge.supports_structured_outputs ||
				Boolean(draft.judge.api_key.trim()) ||
				draft.judge.clear_api_key));
	if (judgeChanged) {
		patch.judge = draft.judge.inherit_chat
			? {
					inherit_chat: true,
					base_url: null,
					model: null,
					supports_structured_outputs: null,
					clear_api_key: true,
				}
			: {
					inherit_chat: false,
					base_url: draft.judge.base_url.trim() || null,
					model: draft.judge.model.trim() || null,
					supports_structured_outputs: draft.judge.supports_structured_outputs,
					...(draft.judge.api_key.trim()
						? { api_key: draft.judge.api_key.trim() }
						: {}),
					...(draft.judge.clear_api_key ? { clear_api_key: true } : {}),
				};
	}

	const rerankChanged =
		draft.rerank.base_url.trim() !== (view.slots.rerank.base_url ?? "") ||
		draft.rerank.model.trim() !== view.slots.rerank.model ||
		Boolean(draft.rerank.api_key.trim()) ||
		draft.rerank.clear_api_key;
	if (rerankChanged) {
		patch.rerank = {
			base_url: draft.rerank.base_url.trim() || null,
			model: draft.rerank.model.trim() || null,
			...(draft.rerank.api_key.trim()
				? { api_key: draft.rerank.api_key.trim() }
				: {}),
			...(draft.rerank.clear_api_key ? { clear_api_key: true } : {}),
		};
	}

	const vlmChanged =
		draft.vlm.enabled !== view.slots.vlm.enabled ||
		(draft.vlm.enabled &&
			(draft.vlm.base_url.trim() !== (view.slots.vlm.base_url ?? "") ||
				draft.vlm.model.trim() !== (view.slots.vlm.model ?? "") ||
				Boolean(draft.vlm.api_key.trim()) ||
				draft.vlm.clear_api_key));
	if (vlmChanged) {
		patch.vlm = draft.vlm.enabled
			? {
					enabled: true,
					base_url: draft.vlm.base_url.trim() || null,
					model: draft.vlm.model.trim() || null,
					...(draft.vlm.api_key.trim()
						? { api_key: draft.vlm.api_key.trim() }
						: {}),
					...(draft.vlm.clear_api_key ? { clear_api_key: true } : {}),
				}
			: {
					enabled: false,
				};
	}

	return patch;
}

function hasDraftChanges(
	draft: DraftState | null,
	view: OrganizationModelSettingsView | undefined,
): boolean {
	if (!draft || !view || view.locked) return false;
	return Object.keys(buildPatchFromDraft(draft, view)).length > 0;
}

function localizeProbeDetail(
	result: ModelConnectionTestResult,
	t: InterfaceText,
): string {
	const slotLabel = result.slot.toUpperCase();
	if (result.ok) {
		if (result.slot === "rerank") {
			if (result.suggestions.base_url) {
				return t(
					`检测到单数 /rerank 路径（${result.checks.rerank_format ?? "results"} 格式），可点击「应用建议配置」自动填入。`,
					result.detail,
				);
			}
			return t(
				`重排端点校验通过（${result.checks.rerank_format ?? "results"} 格式）。`,
				result.detail,
			);
		}
		if (result.slot === "vlm") {
			return t("多模态视觉端点校验通过。", result.detail);
		}
		if (result.checks.structured_outputs === false) {
			return t(
				"端点可连通，但不支持 json_schema 结构化输出；建议关闭该槽位的结构化输出开关。",
				result.detail,
			);
		}
		return t("端点校验通过（支持 json_schema 结构化输出）。", result.detail);
	}

	switch (result.category) {
		case "auth_error":
			return t(
				`${slotLabel} 端点拒绝了凭据（HTTP ${result.status_code ?? 401}），请检查 API Key。`,
				result.detail,
			);
		case "not_found":
			return t(
				`${slotLabel} 端点路径或模型名称不存在（HTTP ${result.status_code ?? 404}）。`,
				result.detail,
			);
		case "rate_limited":
			return t(
				`${slotLabel} 端点触发了上游限流（HTTP 429），请稍后重试。`,
				result.detail,
			);
		case "timeout":
			return t(
				`${slotLabel} 端点探测超时未响应，请检查网络连通性与防火墙。`,
				result.detail,
			);
		case "network_error":
			return t(
				`无法连接到 ${slotLabel} 端点（网络不可达或重定向被拦截）。`,
				result.detail,
			);
		case "invalid_response":
			return t(`${slotLabel} 端点返回了不兼容的响应格式。`, result.detail);
		case "invalid_config": {
			const lower = result.detail.toLowerCase();
			if (lower.includes("api key")) {
				return t(
					`缺少有效的 ${slotLabel} API Key（更换 Base URL 时请填写新端点的密钥）。`,
					result.detail,
				);
			}
			if (lower.includes("model")) {
				return t(`请先填写 ${slotLabel} 模型名称。`, result.detail);
			}
			if (lower.includes("blocked")) {
				return t(
					`${slotLabel} 端点命中元数据或受限地址策略，已被安全拦截。`,
					result.detail,
				);
			}
			if (lower.includes("query") || lower.includes("fragment")) {
				return t(
					`${slotLabel} Base URL 不能包含查询参数（?）或锚点（#）。`,
					result.detail,
				);
			}
			if (lower.includes("disabled")) {
				return t("当前部署配置已禁用 VLM，无法探测。", result.detail);
			}
			return t(
				`${slotLabel} 配置无效，请检查 Base URL、模型名与密钥。`,
				result.detail,
			);
		}
		default:
			return t(
				`${slotLabel} 端点返回错误（HTTP ${result.status_code ?? "未知"}）。`,
				result.detail,
			);
	}
}

function localizeApiError(
	status: number | undefined,
	code: string | undefined,
	detail: string | undefined,
	t: InterfaceText,
): string {
	if (code === "deployment_locked") {
		return t(
			"当前实例已启用部署级锁定模式（MODEL_SETTINGS_LOCKED=true），禁止网页修改或探测自定义端点。",
			detail || "Model settings are locked by deployment configuration.",
		);
	}
	if (code === "version_conflict" || status === 409) {
		return t(
			"配置已被其他管理员更新（版本冲突），请重新加载后再修改。",
			detail || "Model settings were updated elsewhere (version conflict).",
		);
	}
	if (code === "rate_limited" || status === 429) {
		return t(
			"连接探测请求过于频繁，请稍后重试。",
			detail || "Too many connection probes; please retry later.",
		);
	}
	if (code === "rerank_disabled") {
		return t(
			"部署级开关 TS_RETRIEVAL_RERANK_ALLOWED=false 已硬禁用重排。",
			detail || "Reranking is disabled by deployment configuration.",
		);
	}
	if (status === 403) {
		return t(
			"当前账号无权执行此操作（仅组织 Owner 可管理模型配置）。",
			detail || "Forbidden: organization owner access required.",
		);
	}
	if (status === 413) {
		return t("请求体过大，保存失败。", detail || "Request body too large.");
	}
	if (code === "service_unavailable" || status === 503) {
		return t(
			"模型配置服务暂不可用，请稍后重试。",
			detail || "Model settings service temporarily unavailable.",
		);
	}
	const lower = (detail ?? "").toLowerCase();
	if (lower.includes("changing") && lower.includes("base_url")) {
		return t(
			"修改已有加密密钥槽位的 Base URL 时，请同时填写新端点的 API Key 或勾选清除旧密钥，避免向新网关转发旧密钥。",
			detail ||
				"Provide a new API key or clear the old key when changing Base URL.",
		);
	}
	if (lower.includes("api_key is required")) {
		return t(
			"使用自定义或独立端点时必须提供对应槽位的 API Key（本地无鉴权可填 local-no-auth）。",
			detail || "API key is required for a separate endpoint.",
		);
	}
	if (lower.includes("vlm.model is required")) {
		return t(
			"启用 VLM 时必须填写 VLM 模型名称。",
			detail || "VLM model is required.",
		);
	}
	if (lower.includes("blocked metadata")) {
		return t(
			"Base URL 指向受限元数据或非法主机，已被安全策略拦截。",
			detail || "Endpoint targets a blocked host.",
		);
	}
	return (
		detail ||
		t(
			"操作失败，请检查配置后重试。",
			"Operation failed. Please check your configuration.",
		)
	);
}

function SourceBadge({
	source,
	t,
}: {
	source: ModelSlotSource;
	t: InterfaceText;
}) {
	const label = SOURCE_LABELS[source];
	return (
		<span
			className={cn(
				"inline-flex items-center rounded-sm border px-2 py-0.5 text-xs font-medium",
				source === "database" &&
					"border-evidence/40 bg-evidence/10 text-evidence",
				source === "env" && "border-border bg-muted/50 text-muted-foreground",
				source === "inherited" &&
					"border-border bg-muted/30 text-muted-foreground",
				source === "disabled" &&
					"border-border bg-background text-muted-foreground",
			)}
		>
			{t(label[0], label[1])}
		</span>
	);
}

function ProbeResultStrip({
	result,
	locked,
	hideSuggestions = false,
	suggestionNote,
	onApplySuggestions,
	t,
}: {
	result: ModelConnectionTestResult;
	locked: boolean;
	hideSuggestions?: boolean;
	suggestionNote?: string | null;
	onApplySuggestions: () => void;
	t: InterfaceText;
}) {
	const hasSuggestions =
		!locked && !hideSuggestions && Object.keys(result.suggestions).length > 0;
	return (
		<div
			role="status"
			className={cn(
				"mt-3 rounded-md border px-3 py-2.5 text-xs",
				result.ok
					? "border-cite/40 bg-cite/5 text-foreground"
					: "border-destructive/40 bg-destructive/5 text-foreground",
			)}
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-2 font-medium">
					{result.ok ? (
						<CheckCircle2 className="size-4 shrink-0 text-cite" aria-hidden />
					) : (
						<AlertTriangle
							className="size-4 shrink-0 text-destructive"
							aria-hidden
						/>
					)}
					<span>
						{result.ok
							? t("连接探测通过", "Connection verified")
							: t("连接探测失败", "Connection failed")}
					</span>
					<span className="font-mono text-muted-foreground">
						{result.duration_ms}ms
						{result.status_code ? ` · HTTP ${result.status_code}` : ""}
					</span>
				</div>
				{hasSuggestions ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={onApplySuggestions}
						className="h-11 gap-1.5 text-xs md:h-9"
					>
						<Sparkles className="size-3.5" aria-hidden />
						<span>{t("应用建议配置", "Apply suggestions")}</span>
					</Button>
				) : null}
			</div>

			<p className="mt-1.5 text-muted-foreground">
				{localizeProbeDetail(result, t)}
			</p>
			{suggestionNote ? (
				<p className="mt-1 text-muted-foreground">{suggestionNote}</p>
			) : null}

			<div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
				{result.resolved_endpoint ? (
					<span className="font-mono break-all">
						{result.resolved_endpoint}
					</span>
				) : null}
				{result.checks.structured_outputs !== null ? (
					<span>
						{t("json_schema 结构化输出：", "json_schema structured outputs: ")}
						<strong className="text-foreground">
							{result.checks.structured_outputs
								? t("支持", "Supported")
								: t("不支持", "Unsupported")}
						</strong>
					</span>
				) : null}
				{result.checks.include_usage !== null ? (
					<span>
						{t("Usage 用量回传：", "Usage reporting: ")}
						<strong className="text-foreground">
							{result.checks.include_usage
								? t("支持", "Supported")
								: t("未返回", "Not reported")}
						</strong>
					</span>
				) : null}
				{result.checks.rerank_format !== null ? (
					<span>
						{t("重排响应格式：", "Rerank format: ")}
						<strong className="font-mono text-foreground">
							{result.checks.rerank_format}
						</strong>
					</span>
				) : null}
				{result.checks.vision !== null ? (
					<span>
						{t("视觉输入：", "Vision input: ")}
						<strong className="text-foreground">
							{result.checks.vision
								? t("通过", "Verified")
								: t("失败", "Failed")}
						</strong>
					</span>
				) : null}
			</div>
		</div>
	);
}

export function OrganizationModelSettingsPanel({
	onStateChange,
}: {
	onStateChange?: SettingsPanelStateChange;
}) {
	const t = useInterfaceText();
	const baseId = useId();
	const headingId = `${baseId}-heading`;
	const { identity } = useSession();
	const scope = useQueryScope();
	const queryClient = useQueryClient();
	const isOwner = identity.organizationRole === "owner";

	const [draft, setDraft] = useState<DraftState | null>(null);
	const [draftPolicyVersion, setDraftPolicyVersion] = useState<number | null>(
		null,
	);
	const [conflict, setConflict] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [testingSlot, setTestingSlot] = useState<ModelSlot | null>(null);
	const [resetDialogOpen, setResetDialogOpen] = useState(false);
	const [probeResults, setProbeResults] = useState<
		Partial<Record<ModelSlot, ModelConnectionTestResult>>
	>({});

	const settingsQuery = useQuery({
		queryKey: queryKeys.organizationModelSettings(scope),
		enabled: isOwner,
		refetchOnWindowFocus: false,
		queryFn: async (): Promise<OrganizationModelSettingsView> => {
			const response = await fetch(ENDPOINT, { cache: "no-store" });
			const body = (await response.json().catch(() => null)) as
				| OrganizationModelSettingsView
				| { detail?: string; code?: string }
				| null;
			if (!response.ok || !body || !("slots" in body)) {
				const err = new Error(
					(body && "detail" in body && body.detail) ||
						"failed to load model settings",
				) as Error & { status?: number; code?: string };
				err.status = response.status;
				err.code = body && "code" in body ? body.code : undefined;
				throw err;
			}
			return body;
		},
	});

	const view = settingsQuery.data;

	useEffect(() => {
		if (!view) return;
		setDraft((current) => {
			if (current && hasDraftChanges(current, view)) return current;
			setDraftPolicyVersion(view.policy_version);
			return draftFromView(view);
		});
	}, [view]);

	const dirty = useMemo(() => hasDraftChanges(draft, view), [draft, view]);

	function updateDraft(
		affectedSlot: ModelSlot,
		updater: (current: DraftState) => DraftState,
	) {
		setFormError(null);
		setDraft((current) => (current ? updater(current) : current));
		setProbeResults((prev) => {
			if (affectedSlot === "chat") {
				// Judge, Rerank, and VLM may inherit Chat base_url/key, so clear all probes.
				return Object.keys(prev).length === 0 ? prev : {};
			}
			if (!(affectedSlot in prev)) return prev;
			const next = { ...prev };
			delete next[affectedSlot];
			return next;
		});
	}

	const saveMutation = useMutation({
		mutationFn: async (input: {
			patch: OrganizationModelPatch;
			policyVersion: number;
		}) => {
			const response = await fetch(ENDPOINT, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					models: input.patch,
					policy_version: input.policyVersion,
				}),
			});
			const body = (await response.json().catch(() => null)) as
				| OrganizationModelSettingsView
				| { detail?: string; code?: string }
				| null;
			if (!response.ok || !body || !("slots" in body)) {
				const err = new Error(
					(body && "detail" in body && body.detail) ||
						"failed to save model settings",
				) as Error & { status?: number; code?: string };
				err.status = response.status;
				err.code = body && "code" in body ? body.code : undefined;
				throw err;
			}
			return body;
		},
		onSuccess: (nextView) => {
			setConflict(false);
			setFormError(null);
			setResetDialogOpen(false);
			setProbeResults({});
			queryClient.setQueryData(
				queryKeys.organizationModelSettings(scope),
				nextView,
			);
			setDraft(draftFromView(nextView));
			setDraftPolicyVersion(nextView.policy_version);
			toast.success(
				t("模型与供应商配置已保存并生效", "Model settings saved and active"),
			);
		},
		onError: (error: Error & { status?: number; code?: string }) => {
			setResetDialogOpen(false);
			if (error.status === 409 || error.code === "version_conflict") {
				setFormError(null);
				setConflict(true);
				toast.error(
					localizeApiError(error.status, error.code, error.message, t),
				);
				return;
			}
			const localized = localizeApiError(
				error.status,
				error.code,
				error.message,
				t,
			);
			setFormError(localized);
			toast.error(localized);
			if (error.status === 403) {
				void settingsQuery.refetch();
			}
		},
	});

	const busy = saveMutation.isPending || testingSlot !== null;
	useSettingsPanelState(onStateChange, { dirty, busy });

	if (!isOwner) {
		return (
			<section
				id="models"
				aria-labelledby={headingId}
				className="min-w-0 space-y-4 text-sm"
			>
				<h3
					id={headingId}
					className="border-b border-border/70 pb-3 text-base font-medium text-foreground"
				>
					{t("模型与供应商（组织级）", "Models & providers (organization)")}
				</h3>
				<p className="text-muted-foreground">
					{t(
						"仅组织 Owner 可查看或修改模型与供应商配置。",
						"Only organization owners can view or manage model and provider settings.",
					)}
				</p>
			</section>
		);
	}

	if (settingsQuery.isPending && !view) {
		return (
			<section
				id="models"
				aria-labelledby={headingId}
				className="min-w-0 space-y-4 text-sm"
			>
				<h3
					id={headingId}
					className="border-b border-border/70 pb-3 text-base font-medium text-foreground"
				>
					{t("模型与供应商（组织级）", "Models & providers (organization)")}
				</h3>
				<p role="status" className="text-muted-foreground">
					{t("正在加载模型与供应商配置…", "Loading model & provider settings…")}
				</p>
			</section>
		);
	}

	if (settingsQuery.isError || !view || !draft) {
		return (
			<section
				id="models"
				aria-labelledby={headingId}
				className="min-w-0 space-y-4 text-sm"
			>
				<h3
					id={headingId}
					className="border-b border-border/70 pb-3 text-base font-medium text-foreground"
				>
					{t("模型与供应商（组织级）", "Models & providers (organization)")}
				</h3>
				<div className="space-y-3">
					<p role="alert" className="text-destructive">
						{t(
							"无法加载模型与供应商配置，请重试。",
							"Couldn't load model & provider settings. Please retry.",
						)}
					</p>
					<Button
						type="button"
						variant="outline"
						onClick={() => void settingsQuery.refetch()}
						className="h-11 gap-1.5 md:h-9"
					>
						<RefreshCw className="size-4" aria-hidden />
						<span>{t("重新加载", "Reload")}</span>
					</Button>
				</div>
			</section>
		);
	}

	const activeView = view;
	const locked = activeView.locked;
	const activePolicyVersion = draftPolicyVersion ?? activeView.policy_version;
	const unreadableSlots = (["chat", "judge", "rerank", "vlm"] as const).filter(
		(slot) => activeView.slots[slot].api_key_unreadable,
	);

	async function runProbe(slot: ModelSlot) {
		if (!draft || !view || testingSlot !== null) return;
		setTestingSlot(slot);
		setFormError(null);
		try {
			const payload: Record<string, unknown> = { slot };
			if (!locked) {
				payload.chat_draft = {
					base_url: draft.chat.base_url.trim() || null,
					model: draft.chat.model.trim() || null,
					...(draft.chat.api_key.trim()
						? { api_key: draft.chat.api_key.trim() }
						: {}),
					...(draft.chat.clear_api_key ? { clear_api_key: true } : {}),
				};
				if (slot === "chat") {
					payload.base_url = draft.chat.base_url.trim() || null;
					payload.model = draft.chat.model.trim() || null;
					if (draft.chat.api_key.trim())
						payload.api_key = draft.chat.api_key.trim();
					if (draft.chat.clear_api_key) payload.clear_api_key = true;
				} else if (slot === "judge") {
					payload.inherit_chat = draft.judge.inherit_chat;
					if (!draft.judge.inherit_chat) {
						payload.base_url = draft.judge.base_url.trim() || null;
						payload.model = draft.judge.model.trim() || null;
						if (draft.judge.api_key.trim())
							payload.api_key = draft.judge.api_key.trim();
						if (draft.judge.clear_api_key) payload.clear_api_key = true;
					}
				} else if (slot === "rerank") {
					payload.base_url = draft.rerank.base_url.trim() || null;
					payload.model = draft.rerank.model.trim() || null;
					if (draft.rerank.api_key.trim())
						payload.api_key = draft.rerank.api_key.trim();
					if (draft.rerank.clear_api_key) payload.clear_api_key = true;
				} else if (slot === "vlm") {
					payload.base_url = draft.vlm.base_url.trim() || null;
					payload.model = draft.vlm.model.trim() || null;
					if (draft.vlm.api_key.trim())
						payload.api_key = draft.vlm.api_key.trim();
					if (draft.vlm.clear_api_key) payload.clear_api_key = true;
				}
			}

			const response = await fetch(TEST_ENDPOINT, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			const body = (await response.json().catch(() => null)) as
				| ModelConnectionTestResult
				| { detail?: string; code?: string }
				| null;
			if (!response.ok || !body || !("checks" in body)) {
				const code = body && "code" in body ? body.code : undefined;
				const detail = body && "detail" in body ? body.detail : undefined;
				const message = localizeApiError(response.status, code, detail, t);
				toast.error(message);
				if (response.status === 403) {
					void settingsQuery.refetch();
				}
				return;
			}
			setProbeResults((prev) => ({ ...prev, [slot]: body }));
			if (body.ok) {
				toast.success(
					t(
						`${slot.toUpperCase()} 连通性测试通过`,
						`${slot.toUpperCase()} probe passed`,
					),
				);
			} else {
				toast.error(localizeProbeDetail(body, t));
			}
		} catch {
			toast.error(
				t(
					"连接测试请求中断，请检查网络后重试。",
					"Connection test request failed due to a network error.",
				),
			);
		} finally {
			setTestingSlot(null);
		}
	}

	function applyProbeSuggestions(slot: ModelSlot) {
		const probe = probeResults[slot];
		if (!probe || locked) return;
		if (slot === "judge" && draft?.judge.inherit_chat) return;
		updateDraft(slot, (prev) => {
			const next = structuredClone(prev);
			if (slot === "chat") {
				if (probe.suggestions.supports_structured_outputs !== undefined) {
					next.chat.supports_structured_outputs =
						probe.suggestions.supports_structured_outputs;
				}
				if (probe.suggestions.include_usage !== undefined) {
					next.chat.include_usage = probe.suggestions.include_usage;
				}
			} else if (slot === "judge") {
				if (probe.suggestions.supports_structured_outputs !== undefined) {
					next.judge.supports_structured_outputs =
						probe.suggestions.supports_structured_outputs;
				}
			} else if (slot === "rerank") {
				if (probe.suggestions.base_url) {
					next.rerank.base_url = probe.suggestions.base_url;
				}
			}
			return next;
		});
		toast.success(
			t(
				"已将建议配置填入草稿，保存后生效",
				"Suggestions applied to draft; save to activate",
			),
		);
	}

	function handleSave() {
		if (!draft || !view || locked || conflict) return;
		setFormError(null);
		const patch = buildPatchFromDraft(draft, view);
		if (Object.keys(patch).length === 0) return;
		saveMutation.mutate({ patch, policyVersion: activePolicyVersion });
	}

	function handleConfirmResetToEnv() {
		if (!view || locked) return;
		setFormError(null);
		saveMutation.mutate({
			patch: { reset_all: true },
			policyVersion: activePolicyVersion,
		});
	}

	function reloadFresh() {
		setConflict(false);
		setFormError(null);
		setProbeResults({});
		void settingsQuery.refetch().then((res) => {
			if (res.data) {
				setDraft(draftFromView(res.data));
				setDraftPolicyVersion(res.data.policy_version);
			}
		});
	}

	function slotKeyPlaceholder(slot: ModelSlot): string {
		const slotView = activeView.slots[slot];
		if (locked) {
			return slotView.has_effective_api_key
				? t("已由环境变量配置（锁定只读）", "Configured via env (locked)")
				: t("环境变量未配置密钥（锁定只读）", "No env key configured (locked)");
		}
		if (slotView.api_key_unreadable) {
			return t(
				"原加密密钥不可读取，请重新填写或勾选清除",
				"Stored key unreadable; re-enter or clear",
			);
		}
		if (slotView.api_key_hint) {
			return `${t("已加密保存", "Encrypted")}: ${slotView.api_key_hint}`;
		}
		if (slotView.has_effective_api_key) {
			return slot === "chat"
				? t(
						"使用环境密钥（填写新 Key 覆盖）",
						"Using env key (enter to override)",
					)
				: t(
						"已继承有效密钥（异端点需填写）",
						"Inherits active key (enter for separate URL)",
					);
		}
		return slot === "chat"
			? t(
					"必填（无鉴权本地服务填 local-no-auth）",
					"Required (use local-no-auth for local)",
				)
			: t(
					"异端点必填（本地无鉴权填 local-no-auth）",
					"Required for separate URL (local-no-auth for local)",
				);
	}

	return (
		<section
			id="models"
			aria-labelledby={headingId}
			className="min-w-0 space-y-8"
		>
			<div className="space-y-3 border-b border-border pb-6">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="space-y-1">
						<h3
							id={headingId}
							className="text-base font-medium text-foreground"
						>
							{t("模型与供应商（组织级）", "Models & providers (organization)")}
						</h3>
						<p className="text-sm text-muted-foreground">
							{t(
								"仅组织 Owner 可管理。API Key 经 AES-256-GCM 加密落库且永不回显；支持在线切换 Chat、Judge、Rerank 与 VLM，无需重启容器。",
								"Organization Owner only. API keys are encrypted at rest with AES-256-GCM and never echoed back. Switch Chat, Judge, Rerank, and VLM online without restarting containers.",
							)}
						</p>
					</div>
					{!locked ? (
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							<span className="font-mono">v{activePolicyVersion}</span>
							{view.updated_at ? (
								<span>· {formatDateTime(view.updated_at)}</span>
							) : null}
						</div>
					) : null}
				</div>

				{locked ? (
					<div
						role="status"
						className="flex items-start gap-2.5 rounded-md border border-border bg-muted/40 px-3.5 py-3 text-sm"
					>
						<Lock
							className="mt-0.5 size-4 shrink-0 text-muted-foreground"
							aria-hidden
						/>
						<div className="space-y-0.5">
							<p className="font-medium text-foreground">
								{t(
									"已启用部署级锁定模式（MODEL_SETTINGS_LOCKED=true）",
									"Deployment lock mode active (MODEL_SETTINGS_LOCKED=true)",
								)}
							</p>
							<p className="text-xs text-muted-foreground">
								{t(
									"当前实例仅读取服务器环境变量，已禁止网页修改端点或密钥；下方展示现网生效配置，你仍可对已配置端点发起连通性测试。",
									"This instance reads strictly from server environment variables and blocks UI overrides. Effective settings are shown read-only below; you may still probe active endpoints.",
								)}
							</p>
						</div>
					</div>
				) : null}

				{!locked && unreadableSlots.length > 0 ? (
					<div
						role="alert"
						className="flex items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/5 px-3.5 py-3 text-xs text-foreground"
					>
						<AlertTriangle
							className="mt-0.5 size-4 shrink-0 text-destructive"
							aria-hidden
						/>
						<p>
							{t(
								`以下槽位的历史加密密钥无法用当前主密钥解密（${unreadableSlots.join(", ").toUpperCase()}），请重新填入 API Key 或清除后保存。`,
								`Stored encrypted keys could not be decrypted with the active encryption key (${unreadableSlots.join(", ").toUpperCase()}). Re-enter or clear and save.`,
							)}
						</p>
					</div>
				) : null}

				{conflict ? (
					<div
						role="alert"
						className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3.5 py-3 text-sm"
					>
						<span>
							{t(
								"配置已被其他管理员更新（版本冲突），请重新加载后再修改。",
								"Model settings were updated elsewhere (version conflict). Reload before saving.",
							)}
						</span>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={reloadFresh}
							className="h-11 gap-1.5 md:h-9"
						>
							<RefreshCw className="size-3.5" aria-hidden />
							<span>{t("重新加载", "Reload")}</span>
						</Button>
					</div>
				) : null}

				{formError ? (
					<p role="alert" className="text-sm text-destructive">
						{formError}
					</p>
				) : null}
			</div>

			{/* 1. Chat */}
			<section className="space-y-4 border-b border-border pb-6">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div className="flex items-center gap-2">
						<h4 className="text-sm font-semibold text-foreground">
							{t("主对话模型（Chat）", "Primary Chat model")}
						</h4>
						<SourceBadge source={view.slots.chat.source} t={t} />
					</div>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={busy}
						onClick={() => void runProbe("chat")}
						className="h-11 gap-1.5 md:h-9"
					>
						<PlugZap className="size-3.5" aria-hidden />
						<span>
							{testingSlot === "chat"
								? t("探测中…", "Testing…")
								: t("测试连接", "Test connection")}
						</span>
					</Button>
				</div>

				<div className="grid gap-4 sm:grid-cols-2">
					<div className="space-y-1.5">
						<label
							htmlFor={`${baseId}-chat-url`}
							className="text-xs font-medium text-foreground"
						>
							{t("Base URL（OpenAI 兼容）", "Base URL (OpenAI-compatible)")}
						</label>
						<Input
							id={`${baseId}-chat-url`}
							value={draft.chat.base_url}
							disabled={locked || busy}
							onChange={(e) =>
								updateDraft("chat", (prev) => ({
									...prev,
									chat: { ...prev.chat, base_url: e.target.value },
								}))
							}
							placeholder={view.slots.chat.env_base_url}
							className="h-11 font-mono text-base md:h-9 md:text-sm"
						/>
					</div>
					<div className="space-y-1.5">
						<label
							htmlFor={`${baseId}-chat-model`}
							className="text-xs font-medium text-foreground"
						>
							{t("模型名称", "Model name")}
						</label>
						<Input
							id={`${baseId}-chat-model`}
							value={draft.chat.model}
							disabled={locked || busy}
							onChange={(e) =>
								updateDraft("chat", (prev) => ({
									...prev,
									chat: { ...prev.chat, model: e.target.value },
								}))
							}
							placeholder={view.slots.chat.env_model}
							className="h-11 font-mono text-base md:h-9 md:text-sm"
						/>
					</div>
				</div>

				<div className="grid gap-4 sm:grid-cols-2">
					<div className="space-y-1.5">
						<label
							htmlFor={`${baseId}-chat-key`}
							className="flex items-center gap-1.5 text-xs font-medium text-foreground"
						>
							<KeyRound
								className="size-3.5 text-muted-foreground"
								aria-hidden
							/>
							<span>
								{locked
									? t("API Key（只读）", "API Key (read-only)")
									: t(
											"API Key（留空保持不变）",
											"API Key (leave blank to keep)",
										)}
							</span>
						</label>
						<Input
							id={`${baseId}-chat-key`}
							type="password"
							autoComplete="new-password"
							value={draft.chat.api_key}
							disabled={locked || busy}
							onChange={(e) =>
								updateDraft("chat", (prev) => ({
									...prev,
									chat: {
										...prev.chat,
										api_key: e.target.value,
										clear_api_key: false,
									},
								}))
							}
							placeholder={slotKeyPlaceholder("chat")}
							className="h-11 font-mono text-base md:h-9 md:text-sm"
						/>
						{view.slots.chat.has_stored_api_key && !locked ? (
							<div className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground md:min-h-8">
								<Checkbox
									id={`${baseId}-chat-clear-key`}
									checked={draft.chat.clear_api_key}
									disabled={busy}
									onCheckedChange={(checked) =>
										updateDraft("chat", (prev) => ({
											...prev,
											chat: {
												...prev.chat,
												clear_api_key: Boolean(checked),
												api_key: checked ? "" : prev.chat.api_key,
											},
										}))
									}
								/>
								<label
									htmlFor={`${baseId}-chat-clear-key`}
									className="cursor-pointer"
								>
									{t(
										"清除在线加密密钥（回退环境变量）",
										"Clear stored encrypted key (fallback to env)",
									)}
								</label>
							</div>
						) : null}
					</div>

					<div className="flex flex-col justify-center gap-2 pt-1">
						<div className="flex min-h-11 items-center justify-between gap-3 md:min-h-8">
							<label
								htmlFor={`${baseId}-chat-structured`}
								className="cursor-pointer text-xs font-medium text-foreground"
							>
								{t(
									"启用 json_schema 结构化输出",
									"Enable json_schema structured outputs",
								)}
							</label>
							<Switch
								id={`${baseId}-chat-structured`}
								checked={draft.chat.supports_structured_outputs}
								disabled={locked || busy}
								onCheckedChange={(checked) =>
									updateDraft("chat", (prev) => ({
										...prev,
										chat: {
											...prev.chat,
											supports_structured_outputs: checked,
										},
									}))
								}
							/>
						</div>
						<div className="flex min-h-11 items-center justify-between gap-3 md:min-h-8">
							<label
								htmlFor={`${baseId}-chat-usage`}
								className="cursor-pointer text-xs font-medium text-foreground"
							>
								{t(
									"请求流式 Token 用量（include_usage）",
									"Request streaming token usage",
								)}
							</label>
							<Switch
								id={`${baseId}-chat-usage`}
								checked={draft.chat.include_usage}
								disabled={locked || busy}
								onCheckedChange={(checked) =>
									updateDraft("chat", (prev) => ({
										...prev,
										chat: { ...prev.chat, include_usage: checked },
									}))
								}
							/>
						</div>
					</div>
				</div>

				{probeResults.chat ? (
					<ProbeResultStrip
						result={probeResults.chat}
						locked={locked}
						onApplySuggestions={() => applyProbeSuggestions("chat")}
						t={t}
					/>
				) : null}
			</section>

			{/* 2. Judge */}
			<section className="space-y-4 border-b border-border pb-6">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div className="flex items-center gap-2">
						<h4 className="text-sm font-semibold text-foreground">
							{t("证据裁决与冲突核验模型（Judge）", "Evidence Judge model")}
						</h4>
						<SourceBadge source={view.slots.judge.source} t={t} />
					</div>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={busy}
						onClick={() => void runProbe("judge")}
						className="h-11 gap-1.5 md:h-9"
					>
						<PlugZap className="size-3.5" aria-hidden />
						<span>
							{testingSlot === "judge"
								? t("探测中…", "Testing…")
								: t("测试连接", "Test connection")}
						</span>
					</Button>
				</div>

				<div className="flex min-h-11 items-center justify-between gap-3 md:min-h-9">
					<div className="space-y-0.5">
						<label
							htmlFor={`${baseId}-judge-inherit`}
							className="cursor-pointer text-xs font-medium text-foreground"
						>
							{t("复用主对话模型配置", "Inherit Primary Chat model")}
						</label>
						<p className="text-xs text-muted-foreground">
							{t(
								"关闭后可为证据裁决与冲突复核指定独立的高精度模型或专用网关。",
								"Turn off to bind a dedicated high-accuracy model or gateway for evidence adjudication.",
							)}
						</p>
					</div>
					<Switch
						id={`${baseId}-judge-inherit`}
						checked={draft.judge.inherit_chat}
						disabled={locked || busy}
						onCheckedChange={(checked) =>
							updateDraft("judge", (prev) => ({
								...prev,
								judge: { ...prev.judge, inherit_chat: checked },
							}))
						}
					/>
				</div>

				{!draft.judge.inherit_chat ? (
					<div className="space-y-4 pt-1">
						<div className="grid gap-4 sm:grid-cols-2">
							<div className="space-y-1.5">
								<label
									htmlFor={`${baseId}-judge-url`}
									className="text-xs font-medium text-foreground"
								>
									{t("Judge Base URL", "Judge Base URL")}
								</label>
								<Input
									id={`${baseId}-judge-url`}
									value={draft.judge.base_url}
									disabled={locked || busy}
									onChange={(e) =>
										updateDraft("judge", (prev) => ({
											...prev,
											judge: { ...prev.judge, base_url: e.target.value },
										}))
									}
									placeholder={draft.chat.base_url}
									className="h-11 font-mono text-base md:h-9 md:text-sm"
								/>
							</div>
							<div className="space-y-1.5">
								<label
									htmlFor={`${baseId}-judge-model`}
									className="text-xs font-medium text-foreground"
								>
									{t("Judge 模型名称", "Judge model name")}
								</label>
								<Input
									id={`${baseId}-judge-model`}
									value={draft.judge.model}
									disabled={locked || busy}
									onChange={(e) =>
										updateDraft("judge", (prev) => ({
											...prev,
											judge: { ...prev.judge, model: e.target.value },
										}))
									}
									placeholder={view.slots.judge.env_model}
									className="h-11 font-mono text-base md:h-9 md:text-sm"
								/>
							</div>
						</div>
						<div className="grid gap-4 sm:grid-cols-2">
							<div className="space-y-1.5">
								<label
									htmlFor={`${baseId}-judge-key`}
									className="text-xs font-medium text-foreground"
								>
									{locked
										? t("Judge API Key（只读）", "Judge API Key (read-only)")
										: t(
												"Judge API Key（异端点必填）",
												"Judge API Key (required for separate endpoint)",
											)}
								</label>
								<Input
									id={`${baseId}-judge-key`}
									type="password"
									autoComplete="new-password"
									value={draft.judge.api_key}
									disabled={locked || busy}
									onChange={(e) =>
										updateDraft("judge", (prev) => ({
											...prev,
											judge: {
												...prev.judge,
												api_key: e.target.value,
												clear_api_key: false,
											},
										}))
									}
									placeholder={slotKeyPlaceholder("judge")}
									className="h-11 font-mono text-base md:h-9 md:text-sm"
								/>
								{view.slots.judge.has_stored_api_key && !locked ? (
									<div className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground md:min-h-8">
										<Checkbox
											id={`${baseId}-judge-clear-key`}
											checked={draft.judge.clear_api_key}
											disabled={busy}
											onCheckedChange={(checked) =>
												updateDraft("judge", (prev) => ({
													...prev,
													judge: {
														...prev.judge,
														clear_api_key: Boolean(checked),
														api_key: checked ? "" : prev.judge.api_key,
													},
												}))
											}
										/>
										<label
											htmlFor={`${baseId}-judge-clear-key`}
											className="cursor-pointer"
										>
											{t("清除已保存 Judge 密钥", "Clear stored Judge key")}
										</label>
									</div>
								) : null}
							</div>
							<div className="flex min-h-11 items-center justify-between gap-3 pt-2 md:min-h-9 md:pt-6">
								<label
									htmlFor={`${baseId}-judge-structured`}
									className="cursor-pointer text-xs font-medium text-foreground"
								>
									{t(
										"Judge 启用 json_schema 结构化输出",
										"Enable Judge json_schema structured outputs",
									)}
								</label>
								<Switch
									id={`${baseId}-judge-structured`}
									checked={draft.judge.supports_structured_outputs}
									disabled={locked || busy}
									onCheckedChange={(checked) =>
										updateDraft("judge", (prev) => ({
											...prev,
											judge: {
												...prev.judge,
												supports_structured_outputs: checked,
											},
										}))
									}
								/>
							</div>
						</div>
					</div>
				) : null}

				{probeResults.judge ? (
					<ProbeResultStrip
						result={probeResults.judge}
						locked={locked}
						hideSuggestions={draft.judge.inherit_chat}
						suggestionNote={
							draft.judge.inherit_chat &&
							Object.keys(probeResults.judge.suggestions).length > 0
								? t(
										"Judge 当前复用主对话配置，请在上方「主对话模型」中调整结构化输出开关。",
										"Judge currently inherits Primary Chat settings; adjust structured outputs in the Chat section above.",
									)
								: null
						}
						onApplySuggestions={() => applyProbeSuggestions("judge")}
						t={t}
					/>
				) : null}
			</section>

			{/* 3. Rerank */}
			<section className="space-y-4 border-b border-border pb-6">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div className="flex items-center gap-2">
						<h4 className="text-sm font-semibold text-foreground">
							{t("检索重排模型（Rerank）", "Retrieval Reranker")}
						</h4>
						<SourceBadge source={view.slots.rerank.source} t={t} />
					</div>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={
							busy ||
							!view.rerank_allowed ||
							(locked && !view.slots.rerank.configured)
						}
						onClick={() => void runProbe("rerank")}
						className="h-11 gap-1.5 md:h-9"
					>
						<PlugZap className="size-3.5" aria-hidden />
						<span>
							{testingSlot === "rerank"
								? t("探测中…", "Testing…")
								: t("测试连接", "Test connection")}
						</span>
					</Button>
				</div>

				{!view.rerank_allowed ? (
					<p className="text-xs text-muted-foreground">
						{t(
							"部署级开关 TS_RETRIEVAL_RERANK_ALLOWED=false 已硬禁用重排；如需启用请联系运维调整部署配置。",
							"Reranking is hard-disabled by TS_RETRIEVAL_RERANK_ALLOWED=false in deployment configuration.",
						)}
					</p>
				) : (
					<>
						<p className="text-xs text-muted-foreground">
							{t(
								"兼容 DashScope（基础路径自动补 /reranks）以及 vLLM / SiliconFlow / Xinference / Jina / Cohere / Voyage（直接填 .../v1/rerank）。测试连接会自动探测 /rerank 路径与 results/data 响应格式。",
								"Supports DashScope base URLs (/reranks) and explicit .../v1/rerank endpoints (vLLM, SiliconFlow, Xinference, Jina, Cohere, Voyage). Test connection auto-detects /rerank paths and results/data formats.",
							)}
						</p>
						<div className="grid gap-4 sm:grid-cols-2">
							<div className="space-y-1.5">
								<label
									htmlFor={`${baseId}-rerank-url`}
									className="text-xs font-medium text-foreground"
								>
									{t(
										"Rerank Base URL / 完整路径",
										"Rerank Base URL or full /rerank URL",
									)}
								</label>
								<Input
									id={`${baseId}-rerank-url`}
									value={draft.rerank.base_url}
									disabled={locked || busy}
									onChange={(e) =>
										updateDraft("rerank", (prev) => ({
											...prev,
											rerank: { ...prev.rerank, base_url: e.target.value },
										}))
									}
									placeholder="http://host.docker.internal:8002/v1/rerank"
									className="h-11 font-mono text-base md:h-9 md:text-sm"
								/>
							</div>
							<div className="space-y-1.5">
								<label
									htmlFor={`${baseId}-rerank-model`}
									className="text-xs font-medium text-foreground"
								>
									{t("Rerank 模型名称", "Rerank model name")}
								</label>
								<Input
									id={`${baseId}-rerank-model`}
									value={draft.rerank.model}
									disabled={locked || busy}
									onChange={(e) =>
										updateDraft("rerank", (prev) => ({
											...prev,
											rerank: { ...prev.rerank, model: e.target.value },
										}))
									}
									placeholder={view.slots.rerank.env_model}
									className="h-11 font-mono text-base md:h-9 md:text-sm"
								/>
							</div>
						</div>
						<div className="max-w-md space-y-1.5">
							<label
								htmlFor={`${baseId}-rerank-key`}
								className="text-xs font-medium text-foreground"
							>
								{locked
									? t("Rerank API Key（只读）", "Rerank API Key (read-only)")
									: t(
											"Rerank API Key（异端点必填）",
											"Rerank API Key (required for separate endpoint)",
										)}
							</label>
							<Input
								id={`${baseId}-rerank-key`}
								type="password"
								autoComplete="new-password"
								value={draft.rerank.api_key}
								disabled={locked || busy}
								onChange={(e) =>
									updateDraft("rerank", (prev) => ({
										...prev,
										rerank: {
											...prev.rerank,
											api_key: e.target.value,
											clear_api_key: false,
										},
									}))
								}
								placeholder={slotKeyPlaceholder("rerank")}
								className="h-11 font-mono text-base md:h-9 md:text-sm"
							/>
							{view.slots.rerank.has_stored_api_key && !locked ? (
								<div className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground md:min-h-8">
									<Checkbox
										id={`${baseId}-rerank-clear-key`}
										checked={draft.rerank.clear_api_key}
										disabled={busy}
										onCheckedChange={(checked) =>
											updateDraft("rerank", (prev) => ({
												...prev,
												rerank: {
													...prev.rerank,
													clear_api_key: Boolean(checked),
													api_key: checked ? "" : prev.rerank.api_key,
												},
											}))
										}
									/>
									<label
										htmlFor={`${baseId}-rerank-clear-key`}
										className="cursor-pointer"
									>
										{t("清除已保存 Rerank 密钥", "Clear stored Rerank key")}
									</label>
								</div>
							) : null}
						</div>
					</>
				)}

				{probeResults.rerank ? (
					<ProbeResultStrip
						result={probeResults.rerank}
						locked={locked}
						onApplySuggestions={() => applyProbeSuggestions("rerank")}
						t={t}
					/>
				) : null}
			</section>

			{/* 4. VLM */}
			<section className="space-y-4 border-b border-border pb-6">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div className="flex items-center gap-2">
						<h4 className="text-sm font-semibold text-foreground">
							{t("图表视觉模型（VLM）", "Figure Vision model (VLM)")}
						</h4>
						<SourceBadge source={view.slots.vlm.source} t={t} />
					</div>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={busy || !draft.vlm.enabled}
						onClick={() => void runProbe("vlm")}
						className="h-11 gap-1.5 md:h-9"
					>
						<PlugZap className="size-3.5" aria-hidden />
						<span>
							{testingSlot === "vlm"
								? t("探测中…", "Testing…")
								: t("测试视觉连通性", "Test vision")}
						</span>
					</Button>
				</div>

				<div className="flex min-h-11 items-center justify-between gap-3 md:min-h-9">
					<div className="space-y-0.5">
						<label
							htmlFor={`${baseId}-vlm-enabled`}
							className="cursor-pointer text-xs font-medium text-foreground"
						>
							{t(
								"启用按需 PDF 图表读取",
								"Enable on-demand PDF figure reading",
							)}
						</label>
						<p className="text-xs text-muted-foreground">
							{t(
								"开启后仅对授权命中的 PDF 裁剪图表按需调用多模态模型；受限 local_only 文库自动保持边界。",
								"Reads authorized PDF figure crops on demand via a multimodal endpoint; local_only libraries stay strictly isolated.",
							)}
						</p>
					</div>
					<Switch
						id={`${baseId}-vlm-enabled`}
						checked={draft.vlm.enabled}
						disabled={locked || busy}
						onCheckedChange={(checked) =>
							updateDraft("vlm", (prev) => ({
								...prev,
								vlm: { ...prev.vlm, enabled: checked },
							}))
						}
					/>
				</div>

				{draft.vlm.enabled ? (
					<div className="space-y-4 pt-1">
						<div className="grid gap-4 sm:grid-cols-2">
							<div className="space-y-1.5">
								<label
									htmlFor={`${baseId}-vlm-url`}
									className="text-xs font-medium text-foreground"
								>
									{t("VLM Base URL", "VLM Base URL")}
								</label>
								<Input
									id={`${baseId}-vlm-url`}
									value={draft.vlm.base_url}
									disabled={locked || busy}
									onChange={(e) =>
										updateDraft("vlm", (prev) => ({
											...prev,
											vlm: { ...prev.vlm, base_url: e.target.value },
										}))
									}
									placeholder={draft.chat.base_url}
									className="h-11 font-mono text-base md:h-9 md:text-sm"
								/>
							</div>
							<div className="space-y-1.5">
								<label
									htmlFor={`${baseId}-vlm-model`}
									className="text-xs font-medium text-foreground"
								>
									{t("VLM 模型名称（必填）", "VLM model name (required)")}
								</label>
								<Input
									id={`${baseId}-vlm-model`}
									value={draft.vlm.model}
									disabled={locked || busy}
									onChange={(e) =>
										updateDraft("vlm", (prev) => ({
											...prev,
											vlm: { ...prev.vlm, model: e.target.value },
										}))
									}
									placeholder="qwen-vl-plus / Qwen2.5-VL-72B-Instruct"
									className="h-11 font-mono text-base md:h-9 md:text-sm"
								/>
							</div>
						</div>
						<div className="max-w-md space-y-1.5">
							<label
								htmlFor={`${baseId}-vlm-key`}
								className="text-xs font-medium text-foreground"
							>
								{locked
									? t("VLM API Key（只读）", "VLM API Key (read-only)")
									: t(
											"VLM API Key（异端点必填）",
											"VLM API Key (required for separate endpoint)",
										)}
							</label>
							<Input
								id={`${baseId}-vlm-key`}
								type="password"
								autoComplete="new-password"
								value={draft.vlm.api_key}
								disabled={locked || busy}
								onChange={(e) =>
									updateDraft("vlm", (prev) => ({
										...prev,
										vlm: {
											...prev.vlm,
											api_key: e.target.value,
											clear_api_key: false,
										},
									}))
								}
								placeholder={slotKeyPlaceholder("vlm")}
								className="h-11 font-mono text-base md:h-9 md:text-sm"
							/>
							{view.slots.vlm.has_stored_api_key && !locked ? (
								<div className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground md:min-h-8">
									<Checkbox
										id={`${baseId}-vlm-clear-key`}
										checked={draft.vlm.clear_api_key}
										disabled={busy}
										onCheckedChange={(checked) =>
											updateDraft("vlm", (prev) => ({
												...prev,
												vlm: {
													...prev.vlm,
													clear_api_key: Boolean(checked),
													api_key: checked ? "" : prev.vlm.api_key,
												},
											}))
										}
									/>
									<label
										htmlFor={`${baseId}-vlm-clear-key`}
										className="cursor-pointer"
									>
										{t("清除已保存 VLM 密钥", "Clear stored VLM key")}
									</label>
								</div>
							) : null}
						</div>
					</div>
				) : null}

				{draft.vlm.enabled && probeResults.vlm ? (
					<ProbeResultStrip
						result={probeResults.vlm}
						locked={locked}
						onApplySuggestions={() => applyProbeSuggestions("vlm")}
						t={t}
					/>
				) : null}
			</section>

			{/* 5. Embedding (Read-only deployment-locked) */}
			<section className="space-y-3 border-b border-border pb-6">
				<div className="flex items-center gap-2">
					<h4 className="text-sm font-semibold text-foreground">
						{t(
							"向量模型（Embedding · 部署级只读）",
							"Embedding model (deployment-locked)",
						)}
					</h4>
					<span className="inline-flex items-center gap-1 rounded-sm border border-border bg-muted/50 px-2 py-0.5 text-xs font-medium text-muted-foreground">
						<Lock className="size-3" aria-hidden />
						<span>{t("与集合绑定", "Collection-bound")}</span>
					</span>
				</div>
				<p className="text-xs text-muted-foreground">
					{t(
						"Web 检索与 Worker 入库必须使用同一向量空间，因此 Embedding 仅允许通过部署环境变量修改，更换模型或维度时需切换 QDRANT_COLLECTION 并重新索引。",
						"Web queries and Worker indexing must share one vector space. Embedding changes require updating deployment env vars, switching QDRANT_COLLECTION, and reindexing.",
					)}
				</p>
				<dl className="grid gap-3 pt-1 text-xs sm:grid-cols-3">
					<div>
						<dt className="text-muted-foreground">{t("模型", "Model")}</dt>
						<dd className="mt-0.5 font-mono text-foreground">
							{view.embedding.model}
						</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">{t("维度", "Dimensions")}</dt>
						<dd className="mt-0.5 font-mono text-foreground">
							{view.embedding.dimensions}
						</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">
							{t("Qdrant 集合", "Qdrant collection")}
						</dt>
						<dd className="mt-0.5 font-mono text-foreground">
							{view.embedding.collection}
						</dd>
					</div>
				</dl>
			</section>

			{/* Save / Reset action bar */}
			{!locked ? (
				<div className="space-y-3">
					{conflict ? (
						<div
							role="alert"
							className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3.5 py-2.5 text-xs"
						>
							<span>
								{t(
									"检测到版本冲突，请先重新加载最新配置后再保存。",
									"Version conflict detected. Reload the latest settings before saving.",
								)}
							</span>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={reloadFresh}
								className="h-11 gap-1.5 md:h-9"
							>
								<RefreshCw className="size-3.5" aria-hidden />
								<span>{t("重新加载", "Reload")}</span>
							</Button>
						</div>
					) : null}
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div className="flex flex-wrap items-center gap-2">
							<Button
								type="button"
								disabled={!dirty || busy || conflict}
								onClick={handleSave}
								className="h-11 gap-2 md:h-9"
							>
								<Save className="size-4" aria-hidden />
								<span>
									{saveMutation.isPending
										? t("保存中…", "Saving…")
										: t("保存模型配置", "Save model settings")}
								</span>
							</Button>
							<Button
								type="button"
								variant="outline"
								disabled={!dirty || busy}
								onClick={() => {
									setFormError(null);
									setProbeResults({});
									setDraft(draftFromView(view));
									setDraftPolicyVersion(view.policy_version);
								}}
								className="h-11 md:h-9"
							>
								{t("放弃草稿", "Discard draft")}
							</Button>
						</div>
						{view.has_overrides ? (
							<Button
								type="button"
								variant="destructive"
								disabled={busy || conflict}
								onClick={() => setResetDialogOpen(true)}
								className="h-11 gap-1.5 md:h-9"
							>
								<RotateCcw className="size-4" aria-hidden />
								<span>{t("恢复为环境变量默认", "Reset to env defaults")}</span>
							</Button>
						) : null}
					</div>
				</div>
			) : null}

			<AlertDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t(
								"确认恢复为环境变量默认配置？",
								"Reset all model settings to environment defaults?",
							)}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t(
								"此操作将清除 Chat、Judge、Rerank 与 VLM 的全部在线覆盖项及已保存的加密 API Key，并立即回退至服务器环境变量配置。此操作不可撤销。",
								"This permanently deletes all UI overrides and stored encrypted API keys for Chat, Judge, Rerank, and VLM, immediately reverting to server environment variables. This cannot be undone.",
							)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={saveMutation.isPending}>
							{t("取消", "Cancel")}
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={saveMutation.isPending}
							onClick={handleConfirmResetToEnv}
						>
							{saveMutation.isPending
								? t("重置中…", "Resetting…")
								: t("确认重置并清除密钥", "Confirm reset")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</section>
	);
}
