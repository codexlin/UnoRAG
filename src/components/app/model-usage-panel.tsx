"use client";

import type { ModelUsageSummary } from "@/core/ai/model-usage";
import type { Locale } from "@/lib/i18n/locale";
import { useInterfaceLanguage, useInterfaceText } from "@/lib/i18n/provider";

const tokenFormats: Record<Locale, Intl.NumberFormat> = {
	en: new Intl.NumberFormat("en-US"),
	"zh-CN": new Intl.NumberFormat("zh-CN"),
};

function TokenCounts({
	usage,
	partial,
}: {
	usage: Pick<
		ModelUsageSummary,
		"inputTokens" | "outputTokens" | "totalTokens" | "cachedInputTokens"
	>;
	partial: boolean;
}) {
	const { locale } = useInterfaceLanguage();
	const t = useInterfaceText();
	const formatTokens = (value: number | null) =>
		value == null ? t("未知", "Unknown") : tokenFormats[locale].format(value);

	return (
		<>
			<dl className="grid grid-cols-3 gap-3">
				{[
					{
						key: "input",
						label: partial ? t("已知输入", "Known input") : t("输入", "Input"),
						value: usage.inputTokens,
					},
					{
						key: "output",
						label: partial
							? t("已知输出", "Known output")
							: t("输出", "Output"),
						value: usage.outputTokens,
					},
					{
						key: "total",
						label: partial ? t("已知合计", "Known total") : t("合计", "Total"),
						value: usage.totalTokens,
					},
				].map(({ key, label, value }) => (
					<div key={key} className="min-w-0 space-y-1">
						<dt className="text-xs text-muted-foreground">{label}</dt>
						<dd className="break-all font-mono text-xs tabular-nums">
							{formatTokens(value)}
						</dd>
					</div>
				))}
			</dl>
			<p className="text-xs text-muted-foreground">
				{partial
					? t("已知缓存输入", "Known cached input")
					: t("缓存输入", "Cached input")}{" "}
				<span className="font-mono tabular-nums">
					{formatTokens(usage.cachedInputTokens)}
				</span>{" "}
				{t("（包含在输入内）", "(included in input)")}
			</p>
		</>
	);
}

export function ModelUsagePanel({
	usage,
}: {
	usage?: ModelUsageSummary | null;
}) {
	const t = useInterfaceText();
	const usageLabels = {
		reported: t("已上报", "Reported"),
		partial: t("部分已知", "Partial"),
		unavailable: t("用量未知", "Unknown"),
		not_used: t("未调用 LLM", "No LLM call"),
	} as const;
	const callLabels = {
		completed: t("已完成", "Completed"),
		failed: t("失败", "Failed"),
		cancelled: t("已取消", "Cancelled"),
	} as const;
	const partial = usage?.status === "partial" || usage?.truncated === true;
	const hasCalls = usage != null && usage.calls.length > 0;
	return (
		<section
			aria-label={t("模型 Token 用量", "Model token usage")}
			className="min-w-0 space-y-3 border-t border-border/70 pt-4"
		>
			<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
				<h3 className="text-ui font-semibold">
					{t("模型 Token 用量", "Model token usage")}
				</h3>
				<span className="text-xs text-muted-foreground">
					{usage ? usageLabels[usage.status] : t("未记录", "Not recorded")}
				</span>
			</div>
			<p className="text-xs text-muted-foreground">
				{t(
					"仅 LLM，不含 Embedding / Rerank；不代表费用。",
					"LLM only (excludes embedding and rerank); not a cost estimate.",
				)}
			</p>
			{!usage ? (
				<p className="text-xs text-muted-foreground">
					{t(
						"此请求未记录模型用量，不能视为零消耗。",
						"Model usage was not recorded for this request; do not treat as zero usage.",
					)}
				</p>
			) : usage.status === "not_used" ? (
				<p className="text-xs text-muted-foreground">
					{t("此请求未调用 LLM。", "No LLM was called for this request.")}
				</p>
			) : (
				<>
					<TokenCounts usage={usage} partial={partial} />
					{partial ? (
						<p className="text-xs text-muted-foreground">
							{t(
								"仅统计已知用量，不是完整请求总量；未知不计为零。",
								"Known counts only, not the full request total; unknown values are not counted as zero.",
							)}
						</p>
					) : usage.status === "unavailable" ? (
						<p className="text-xs text-muted-foreground">
							{t(
								"模型用量未上报，不能视为零消耗。",
								"Model usage was not reported; do not treat as zero usage.",
							)}
						</p>
					) : null}
				</>
			)}
			{hasCalls ? (
				<ol
					aria-label={t("模型调用", "Model calls")}
					className="divide-y divide-border/60"
				>
					{usage.calls.map((call, index) => (
						<li
							// biome-ignore lint/suspicious/noArrayIndexKey: Append-only call records have no ID and stage/attempt may repeat.
							key={`${call.stage}-${call.attempt}-${index}`}
							className="min-w-0 space-y-2 py-3 first:pt-0 last:pb-0"
						>
							<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
								<p className="min-w-0 break-all">
									<span className="font-mono">{call.stage}</span>
									<span className="ml-2 text-muted-foreground">
										{t(`尝试 ${call.attempt}`, `Attempt ${call.attempt}`)}
									</span>
								</p>
								<span
									className={
										call.status === "failed"
											? "text-destructive"
											: "text-muted-foreground"
									}
								>
									{callLabels[call.status]} · {usageLabels[call.usageStatus]}
								</span>
							</div>
							<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
								<dt className="text-muted-foreground">{t("模型", "Model")}</dt>
								<dd className="break-all font-mono">
									{call.model ?? t("未知", "Unknown")}
								</dd>
								<dt className="text-muted-foreground">Provider</dt>
								<dd className="break-all font-mono">
									{call.provider ?? t("未知", "Unknown")}
								</dd>
							</dl>
							<TokenCounts
								usage={call}
								partial={call.usageStatus === "partial"}
							/>
						</li>
					))}
				</ol>
			) : null}
			{usage?.truncated ? (
				<p className="text-xs text-muted-foreground">
					{t(
						"调用记录已截断，仅展示保留的记录。",
						"Call records were truncated; only retained records are shown.",
					)}
				</p>
			) : null}
		</section>
	);
}
