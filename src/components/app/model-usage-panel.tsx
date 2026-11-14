import type { ModelUsageSummary } from "@/core/ai/model-usage";

const USAGE_LABELS = {
	reported: "已上报",
	partial: "部分已知",
	unavailable: "用量未知",
	not_used: "未调用 LLM",
} as const;

const CALL_LABELS = {
	completed: "已完成",
	failed: "失败",
	cancelled: "已取消",
} as const;

const tokenFormat = new Intl.NumberFormat("zh-CN");

function tokens(value: number | null) {
	return value == null ? "未知" : tokenFormat.format(value);
}

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
	return (
		<>
			<dl className="grid grid-cols-3 gap-3">
				{[
					{ label: "输入", value: usage.inputTokens },
					{ label: "输出", value: usage.outputTokens },
					{ label: "合计", value: usage.totalTokens },
				].map(({ label, value }) => (
					<div key={label} className="min-w-0 space-y-1">
						<dt className="text-xs text-muted-foreground">
							{partial ? `已知${label}` : label}
						</dt>
						<dd className="break-all font-mono text-xs tabular-nums">
							{tokens(value)}
						</dd>
					</div>
				))}
			</dl>
			<p className="text-xs text-muted-foreground">
				{partial ? "已知缓存输入" : "缓存输入"}{" "}
				<span className="font-mono tabular-nums">
					{tokens(usage.cachedInputTokens)}
				</span>{" "}
				（包含在输入内）
			</p>
		</>
	);
}

export function ModelUsagePanel({
	usage,
}: {
	usage?: ModelUsageSummary | null;
}) {
	const partial = usage?.status === "partial" || usage?.truncated === true;
	const hasCalls = usage != null && usage.calls.length > 0;
	return (
		<section
			aria-label="模型 Token 用量"
			className="min-w-0 space-y-3 border-t border-border/70 pt-4"
		>
			<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
				<h3 className="text-ui font-semibold">模型 Token 用量</h3>
				<span className="text-xs text-muted-foreground">
					{usage ? USAGE_LABELS[usage.status] : "未记录"}
				</span>
			</div>
			<p className="text-xs text-muted-foreground">
				仅 LLM，不含 Embedding / Rerank；不代表费用。
			</p>
			{!usage ? (
				<p className="text-xs text-muted-foreground">
					此请求未记录模型用量，不能视为零消耗。
				</p>
			) : usage.status === "not_used" ? (
				<p className="text-xs text-muted-foreground">此请求未调用 LLM。</p>
			) : (
				<>
					<TokenCounts usage={usage} partial={partial} />
					{partial ? (
						<p className="text-xs text-muted-foreground">
							仅统计已知用量，不是完整请求总量；未知不计为零。
						</p>
					) : usage.status === "unavailable" ? (
						<p className="text-xs text-muted-foreground">
							模型用量未上报，不能视为零消耗。
						</p>
					) : null}
				</>
			)}
			{hasCalls ? (
				<ol aria-label="模型调用" className="divide-y divide-border/60">
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
										尝试 {call.attempt}
									</span>
								</p>
								<span
									className={
										call.status === "failed"
											? "text-destructive"
											: "text-muted-foreground"
									}
								>
									{CALL_LABELS[call.status]} · {USAGE_LABELS[call.usageStatus]}
								</span>
							</div>
							<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
								<dt className="text-muted-foreground">模型</dt>
								<dd className="break-all font-mono">{call.model ?? "未知"}</dd>
								<dt className="text-muted-foreground">Provider</dt>
								<dd className="break-all font-mono">
									{call.provider ?? "未知"}
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
					调用记录已截断，仅展示保留的记录。
				</p>
			) : null}
		</section>
	);
}
