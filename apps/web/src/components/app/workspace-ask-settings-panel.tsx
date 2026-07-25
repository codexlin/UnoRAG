"use client";

import { CircleHelp } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useSession } from "@/components/app/session-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";

type AskDefaults = {
	retrieve_top_k: number;
	answer_min_score: number;
	hybrid_enabled: boolean;
	rerank_enabled: boolean;
	citation_adjudicate_enabled: boolean;
	citation_adjudicate_absolute_floor: number;
	session_memory_enabled: boolean;
	session_memory_max_turns: number;
};

type AskSettings = Partial<AskDefaults>;

type FieldKey = keyof AskDefaults;

const FIELDS: {
	key: FieldKey;
	label: string;
	kind: "int" | "float" | "bool";
	hint?: string;
	/** Hover tip：产品说明，与 ASK_SETTING_DEFAULTS 默认值对齐 */
	tip: string;
}[] = [
	{
		key: "retrieve_top_k",
		label: "引用条数上限",
		kind: "int",
		hint: "1–20",
		tip: "引用条数上限。偏大=更全但更吵/更贵；常见 4–8，默认 6。",
	},
	{
		key: "answer_min_score",
		label: "弱相关拒答阈值",
		kind: "float",
		hint: "0–1",
		tip: "弱相关拒答阈值。偏高=更严（少瞎答），偏低=更敢答。默认 0.4。",
	},
	{
		key: "hybrid_enabled",
		label: "混合检索",
		kind: "bool",
		tip: "混合检索（向量+关键词）。专名/编号/精确字段多时建议开；一般叙述问答可关。默认关。",
	},
	{
		key: "rerank_enabled",
		label: "重排",
		kind: "bool",
		tip: "重排。需已配置重排/LLM；要更准排序时开，会增加延迟与费用。默认关。",
	},
	{
		key: "citation_adjudicate_enabled",
		label: "引用裁决",
		kind: "bool",
		tip: "引用裁决，滤掉弱引用。生产建议开。默认开。",
	},
	{
		key: "citation_adjudicate_absolute_floor",
		label: "裁决绝对分下限",
		kind: "float",
		hint: "0–1",
		tip: "裁决绝对分下限。越高越严。默认 0.35。",
	},
	{
		key: "session_memory_enabled",
		label: "多轮短记忆",
		kind: "bool",
		tip: "多轮短记忆。跟进追问建议开。默认开。",
	},
	{
		key: "session_memory_max_turns",
		label: "记忆轮数",
		kind: "int",
		hint: "0–20",
		tip: "兼容字段；实际工作记忆窗口由服务端代码常量决定（当前约 10 轮）。",
	},
];

function formatDefault(value: number | boolean | undefined): string {
	if (typeof value === "boolean") return value ? "开" : "关";
	if (typeof value === "number") return String(value);
	return "—";
}

export function WorkspaceAskSettingsPanel() {
	const { can } = useSession();
	const canManage = can("manageMembers");
	const [ask, setAsk] = useState<AskSettings>({});
	const [defaults, setDefaults] = useState<AskDefaults | null>(null);
	const [draft, setDraft] = useState<AskSettings>({});
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
			defaults: AskDefaults;
		};
		setAsk(data.ask);
		setDraft(data.ask);
		setDefaults(data.defaults);
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	function setField(key: FieldKey, value: unknown) {
		setSaved(false);
		setDraft((prev) => {
			const next = { ...prev };
			if (value === undefined) {
				delete next[key];
			} else {
				(next as Record<string, unknown>)[key] = value;
			}
			return next;
		});
	}

	function clearField(key: FieldKey) {
		setField(key, undefined);
	}

	async function save() {
		if (!canManage) return;
		setBusy(true);
		setError(null);
		setSaved(false);

		const patch: Record<string, unknown> = {};
		for (const field of FIELDS) {
			const key = field.key;
			const had = Object.hasOwn(ask, key);
			const has = Object.hasOwn(draft, key);
			if (!had && !has) continue;
			if (had && !has) {
				patch[key] = null;
				continue;
			}
			if (has && draft[key] !== ask[key]) {
				patch[key] = draft[key];
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
			setError(
				typeof detail?.detail === "string" ? detail.detail : "保存失败",
			);
			return;
		}
		const data = (await response.json()) as {
			ask: AskSettings;
			defaults: AskDefaults;
		};
		setAsk(data.ask);
		setDraft(data.ask);
		setDefaults(data.defaults);
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
					问答与检索。未覆盖的项使用代码默认。
					{!canManage ? " 查看者/编辑者只读。" : ""}
				</p>
			</div>

			<ul className="space-y-3">
				{FIELDS.map((field) => {
					const overridden = Object.hasOwn(draft, field.key);
					const defaultValue = defaults?.[field.key];
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
									{overridden
										? "已覆盖"
										: `未覆盖 · 默认 ${formatDefault(defaultValue)}`}
									{field.hint ? ` · ${field.hint}` : ""}
								</p>
							</div>
							<div className="flex items-center gap-2">
								{field.kind === "bool" ? (
									<select
										className="rounded-md border border-border bg-background px-2 py-1 text-xs"
										disabled={!canManage}
										value={
											overridden
												? draft[field.key]
													? "true"
													: "false"
												: ""
										}
										onChange={(event) => {
											const v = event.target.value;
											if (v === "") clearField(field.key);
											else setField(field.key, v === "true");
										}}
									>
										<option value="">默认</option>
										<option value="true">开</option>
										<option value="false">关</option>
									</select>
								) : (
									<>
										<Label htmlFor={`ask-${field.key}`} className="sr-only">
											{field.label}
										</Label>
										<Input
											id={`ask-${field.key}`}
											type="number"
											step={field.kind === "float" ? "0.01" : "1"}
											className="h-8 w-24 font-mono text-xs"
											disabled={!canManage}
											placeholder={
												defaultValue != null ? String(defaultValue) : ""
											}
											value={
												overridden && draft[field.key] != null
													? String(draft[field.key])
													: ""
											}
											onChange={(event) => {
												const raw = event.target.value.trim();
												if (raw === "") {
													clearField(field.key);
													return;
												}
												const num = Number(raw);
												if (!Number.isFinite(num)) return;
												setField(
													field.key,
													field.kind === "int" ? Math.trunc(num) : num,
												);
											}}
										/>
									</>
								)}
								{canManage && overridden ? (
									<button
										type="button"
										className="text-xs text-muted-foreground underline-offset-2 hover:underline"
										onClick={() => clearField(field.key)}
									>
										清除
									</button>
								) : null}
							</div>
						</li>
					);
				})}
			</ul>

			{error ? <p className="text-ui text-destructive">{error}</p> : null}
			{saved ? (
				<p className="text-ui text-muted-foreground">已保存</p>
			) : null}

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
