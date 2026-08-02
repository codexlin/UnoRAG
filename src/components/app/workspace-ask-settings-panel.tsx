"use client";

import { CircleHelp } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useSession } from "@/components/app/session-provider";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";

type AskSettings = {
	answer_profile: "precise" | "balanced" | "exploratory";
	retrieval_enhancement: "auto" | "off" | "on";
	session_memory_enabled: boolean;
	evidence_requirement: "strict" | "standard" | "relaxed";
};

type FieldKey = keyof AskSettings;

const FIELDS: {
	key: FieldKey;
	label: string;
	tip: string;
	kind: "enum" | "bool";
	options?: { value: string; label: string }[];
}[] = [
	{
		key: "answer_profile",
		label: "回答模式",
		kind: "enum",
		tip: "精确=证据不足时更易拒答；均衡=默认；探索=更宽召回、更敢关联线索。",
		options: [
			{ value: "precise", label: "精确" },
			{ value: "balanced", label: "均衡" },
			{ value: "exploratory", label: "探索" },
		],
	},
	{
		key: "retrieval_enhancement",
		label: "检索增强",
		kind: "enum",
		tip: "关闭=仅向量；开启=混合检索+重排（若可用）；自动=按问法启发式或产品默认，并在问答轨迹中记录实际取值。",
		options: [
			{ value: "auto", label: "自动" },
			{ value: "off", label: "关闭" },
			{ value: "on", label: "开启" },
		],
	},
	{
		key: "session_memory_enabled",
		label: "对话记忆",
		kind: "bool",
		tip: "多轮追问时保留短上下文。默认开。",
	},
	{
		key: "evidence_requirement",
		label: "证据要求",
		kind: "enum",
		tip: "严格/标准/宽松，调节拒答与引用裁决；与回答模式冲突时取更严一侧。",
		options: [
			{ value: "strict", label: "严格" },
			{ value: "standard", label: "标准" },
			{ value: "relaxed", label: "宽松" },
		],
	},
];

function formatDefault(key: FieldKey, defaults: AskSettings | null): string {
	if (!defaults) return "—";
	const value = defaults[key];
	if (typeof value === "boolean") return value ? "开" : "关";
	const field = FIELDS.find((item) => item.key === key);
	const option = field?.options?.find((item) => item.value === value);
	return option?.label ?? String(value);
}

export function WorkspaceAskSettingsPanel() {
	const { can } = useSession();
	const canManage = can("manageMembers");
	const [ask, setAsk] = useState<AskSettings | null>(null);
	const [defaults, setDefaults] = useState<AskSettings | null>(null);
	const [draft, setDraft] = useState<AskSettings | null>(null);
	const [policyVersion, setPolicyVersion] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(true);

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		const response = await fetch("/api/workspace/settings");
		setLoading(false);
		if (!response.ok) {
			setError("无法加载工作区设置");
			return;
		}
		const data = (await response.json()) as {
			ask: AskSettings;
			defaults: AskSettings;
			policy_version?: number;
		};
		setAsk(data.ask);
		setDraft(data.ask);
		setDefaults(data.defaults);
		setPolicyVersion(
			typeof data.policy_version === "number" ? data.policy_version : null,
		);
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	function setField<K extends FieldKey>(key: K, value: AskSettings[K]) {
		setSaved(false);
		setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
	}

	async function save() {
		if (!canManage || !ask || !draft) return;
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

		const response = await fetch("/api/workspace/settings", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ask: patch }),
		});
		setBusy(false);
		if (!response.ok) {
			const detail = await response.json().catch(() => null);
			setError(typeof detail?.detail === "string" ? detail.detail : "保存失败");
			return;
		}
		const data = (await response.json()) as {
			ask: AskSettings;
			defaults: AskSettings;
			policy_version?: number;
		};
		setAsk(data.ask);
		setDraft(data.ask);
		setDefaults(data.defaults);
		setPolicyVersion(
			typeof data.policy_version === "number" ? data.policy_version : null,
		);
		setSaved(true);
	}

	if (loading && !defaults) {
		return (
			<div className="space-y-2 rounded-2xl border border-border/80 bg-card/80 px-4 py-4">
				<p className="text-meta font-mono tracking-[0.16em] text-muted-foreground uppercase">
					Ask
				</p>
				<p className="text-ui text-muted-foreground">加载中…</p>
			</div>
		);
	}

	return (
		<div className="space-y-4 rounded-2xl border border-border/80 bg-card/80 px-4 py-4">
			<div>
				<p className="text-meta font-mono tracking-[0.16em] text-muted-foreground uppercase">
					Ask
				</p>
				<p className="text-ui mt-1 text-muted-foreground">
					问答策略（业务意图）。算法细节由服务端映射，不在此暴露。
					{!canManage ? " 查看者/编辑者只读。" : ""}
					{policyVersion != null ? ` · 策略版本 ${policyVersion}` : ""}
				</p>
			</div>

			<ul className="space-y-3">
				{FIELDS.map((field) => {
					const value = draft?.[field.key];
					return (
						<li
							key={field.key}
							className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-3 last:border-0 last:pb-0"
						>
							<div className="min-w-0">
								<div className="flex items-center gap-1">
									<p className="text-sm font-medium">{field.label}</p>
									<Tooltip>
										<TooltipTrigger
											render={
												<button
													type="button"
													className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
													aria-label={`${field.label}说明`}
												>
													<CircleHelp className="size-3.5" aria-hidden />
												</button>
											}
										/>
										<TooltipContent
											side="top"
											align="start"
											className="max-w-[18rem] text-left leading-relaxed"
										>
											{field.tip}
										</TooltipContent>
									</Tooltip>
								</div>
								<p className="font-mono text-xs text-muted-foreground">
									默认 {formatDefault(field.key, defaults)}
								</p>
							</div>
							<div className="flex items-center gap-2">
								{field.kind === "bool" ? (
									<select
										className="rounded-md border border-border bg-background px-2 py-1 text-xs"
										disabled={!canManage || value == null}
										value={value ? "true" : "false"}
										onChange={(event) => {
											setField(
												"session_memory_enabled",
												event.target.value === "true",
											);
										}}
									>
										<option value="true">开</option>
										<option value="false">关</option>
									</select>
								) : (
									<select
										className="rounded-md border border-border bg-background px-2 py-1 text-xs"
										disabled={!canManage || value == null}
										value={String(value ?? "")}
										onChange={(event) => {
											setField(
												field.key,
												event.target.value as AskSettings[typeof field.key],
											);
										}}
									>
										{(field.options ?? []).map((option) => (
											<option key={option.value} value={option.value}>
												{option.label}
											</option>
										))}
									</select>
								)}
							</div>
						</li>
					);
				})}
			</ul>

			{error ? <p className="text-ui text-destructive">{error}</p> : null}
			{saved ? <p className="text-ui text-muted-foreground">已保存</p> : null}

			{canManage ? (
				<div className="pt-1">
					<Button
						type="button"
						size="sm"
						disabled={busy}
						onClick={() => void save()}
					>
						{busy ? "保存中…" : "保存"}
					</Button>
				</div>
			) : null}
		</div>
	);
}
