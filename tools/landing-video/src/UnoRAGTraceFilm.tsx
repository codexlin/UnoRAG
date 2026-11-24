import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import {
	EASE,
	FilmFonts,
	FilmGrain,
	type FilmProps,
	FONT_MONO,
	FONT_SANS,
	SwissStage,
	alpha,
	getPalette,
	mix,
	pickText,
	ramp,
	springAt,
} from "./theme";

export const UnoRAGTraceFilm: React.FC<FilmProps> = ({ locale, theme }) => {
	const frame = useCurrentFrame();
	const palette = getPalette(theme);

	// Honest sequential stage timing breakdown (NEVER claims parallel timeline per DESIGN.md!)
	const stages = [
		{
			name: pickText(locale, "权限范围解析", "Access scope check"),
			msVal: 18,
			unit: "ms" as const,
			startPct: 0,
			widthPct: 4.5,
			startFrame: 6,
			dur: 16,
		},
		{
			name: pickText(locale, "混合检索与重排", "Hybrid retrieval & rerank"),
			msVal: 294,
			unit: "ms" as const,
			startPct: 4.5,
			widthPct: 14.5,
			startFrame: 22,
			dur: 32,
		},
		{
			name: pickText(locale, "证据充分性判断", "Evidence judge"),
			msVal: 1.42,
			unit: "s" as const,
			startPct: 19,
			widthPct: 30,
			startFrame: 54,
			dur: 44,
		},
		{
			name: pickText(locale, "带引用回答生成", "Cited answer generation"),
			msVal: 2.81,
			unit: "s" as const,
			startPct: 49,
			widthPct: 51,
			startFrame: 98,
			dur: 56,
		},
	];

	const allDone = frame >= 156;
	const badgePop = springAt(frame, 156, {
		damping: 16,
		stiffness: 220,
		mass: 0.9,
	});

	// Rolling cumulative sequential sum (honestly sums reported stage durations)
	const seqSec =
		0.018 * ramp(frame, 6, 16, EASE.out) +
		0.294 * ramp(frame, 22, 32, EASE.out) +
		1.42 * ramp(frame, 54, 44, EASE.out) +
		2.81 * ramp(frame, 98, 56, EASE.out);

	// Honest per-call LLM token ledger (starts populated enough at f0, counts cleanly up as judge + generate run!)
	const judgeP = ramp(frame, 58, 40, EASE.out);
	const genP = ramp(frame, 102, 54, EASE.out);
	const inputTokens = Math.round(1020 * Math.max(0.35, judgeP) + 1820 * genP);
	const outputTokens = Math.round(94 * Math.max(0.35, judgeP) + 292 * genP);
	const totalTokens = inputTokens + outputTokens;

	const metaCards = [
		[pickText(locale, "问题类型", "Query type"), "fact"],
		[pickText(locale, "检索模式", "Retrieval"), "hybrid"],
		[pickText(locale, "重排执行", "Rerank"), pickText(locale, "已执行", "Applied")],
		[pickText(locale, "拒答原因", "Refusal"), "—"],
	];

	return (
		<AbsoluteFill
			style={{
				backgroundColor: palette.bg,
				fontFamily: FONT_SANS,
				color: palette.fg,
				padding: 34,
				boxSizing: "border-box",
				display: "flex",
				flexDirection: "column",
				gap: 20,
				overflow: "hidden",
			}}
		>
			<FilmFonts />
			<SwissStage theme={theme} palette={palette} gridSize={44} />

			{/* Header */}
			<div
				style={{
					position: "relative",
					zIndex: 2,
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					borderBottom: `1px solid ${palette.border}`,
					paddingBottom: 18,
				}}
			>
				<div>
					<div
						style={{
							fontSize: 23,
							fontWeight: 650,
							letterSpacing: "-0.025em",
						}}
					>
						{pickText(locale, "请求链路详情", "Request Trace Detail")}
					</div>
					<div
						style={{
							fontSize: 13.5,
							color: palette.mutedFg,
							marginTop: 5,
							fontFamily: FONT_MONO,
						}}
					>
						req_9f42c8a1 · Ask · hybrid + rerank
					</div>
				</div>
				<span
					style={{
						padding: "7px 15px",
						borderRadius: 999,
						backgroundColor: allDone ? palette.cite : palette.citeBg,
						border: `1px solid ${palette.citeBorder}`,
						color: allDone ? palette.citeSolidFg : palette.cite,
						fontSize: 13,
						fontWeight: 650,
						transform: allDone
							? `scale(${mix(1.06, 1, badgePop).toFixed(4)})`
							: "none",
						boxShadow: allDone ? palette.shadowSm : "none",
					}}
				>
					{allDone
						? pickText(locale, "✓ 已完成 · 2 处引用", "✓ Completed · 2 citations")
						: pickText(locale, "● 链路记录中…", "● Recording trace…")}
				</span>
			</div>

			{/* Metadata Grid (subtle staggered settle) */}
			<div
				style={{
					position: "relative",
					zIndex: 2,
					display: "grid",
					gridTemplateColumns: "repeat(4, 1fr)",
					gap: 12,
				}}
			>
				{metaCards.map(([k, v], idx) => {
					const p = ramp(frame, idx * 3, 12, EASE.snappy);
					return (
						<div
							key={k}
							style={{
								backgroundColor: palette.card,
								border: `1px solid ${palette.border}`,
								borderRadius: 11,
								padding: "13px 15px",
								boxShadow: palette.shadowSm,
								opacity: mix(0.7, 1, p),
								transform: `translateY(${((1 - p) * 6).toFixed(2)}px)`,
							}}
						>
							<div style={{ fontSize: 12, color: palette.mutedFg }}>{k}</div>
							<div
								style={{
									fontSize: 15.5,
									fontWeight: 650,
									fontFamily: FONT_MONO,
									marginTop: 5,
								}}
							>
								{v}
							</div>
						</div>
					);
				})}
			</div>

			{/* Sequential Stage Timing Breakdown */}
			<div
				style={{
					position: "relative",
					zIndex: 2,
					backgroundColor: palette.card,
					border: `1px solid ${palette.border}`,
					borderRadius: 14,
					padding: "22px 24px",
					display: "flex",
					flexDirection: "column",
					gap: 17,
					boxShadow: palette.shadow,
				}}
			>
				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "baseline",
					}}
				>
					<div>
						<span style={{ fontSize: 15.5, fontWeight: 650 }}>
							{pickText(locale, "阶段耗时瀑布", "Stage Timing Breakdown")}
						</span>
						<span
							style={{
								fontSize: 12.5,
								color: palette.mutedFg,
								marginLeft: 10,
							}}
						>
							{pickText(
								locale,
								"4 步 · 顺序展示耗时",
								"4 stages · sequential sum",
							)}
						</span>
					</div>
					<span
						style={{
							fontFamily: FONT_MONO,
							fontSize: 16,
							fontWeight: 700,
							color: allDone ? palette.cite : palette.fg,
							fontVariantNumeric: "tabular-nums",
						}}
					>
						{seqSec.toFixed(2)}s
					</span>
				</div>

				{stages.map((stage) => {
					const prog = ramp(frame, stage.startFrame, stage.dur, EASE.out);
					const running =
						frame >= stage.startFrame && frame < stage.startFrame + stage.dur;
					const done = frame >= stage.startFrame + stage.dur;
					const donePop = springAt(frame, stage.startFrame + stage.dur, {
						damping: 16,
						stiffness: 240,
						mass: 0.85,
					});
					const curLabel =
						prog <= 0.04
							? "—"
							: stage.unit === "ms"
								? `${Math.round(stage.msVal * prog)}ms`
								: `${(stage.msVal * prog).toFixed(2)}s`;

					return (
						<div
							key={stage.name}
							style={{
								display: "grid",
								gridTemplateColumns: "228px 1fr 78px",
								alignItems: "center",
								gap: 16,
							}}
						>
							<div
								style={{
									display: "flex",
									alignItems: "center",
									gap: 9,
									fontSize: 14.5,
								}}
							>
								<span
									style={{
										display: "inline-flex",
										alignItems: "center",
										justifyContent: "center",
										width: 20,
										height: 20,
										borderRadius: 99,
										backgroundColor: done
											? palette.citeBg
											: running
												? palette.evidenceBg
												: "transparent",
										color: done
											? palette.cite
											: running
												? palette.evidence
												: palette.dimFg,
										fontSize: 12,
										fontWeight: 700,
										transform: done
											? `scale(${mix(0.75, 1, donePop).toFixed(3)})`
											: "none",
									}}
								>
									{done ? "✓" : running ? "●" : "○"}
								</span>
								<span
									style={{
										fontWeight: running || done ? 600 : 500,
										color: running || done ? palette.fg : palette.mutedFg,
									}}
								>
									{stage.name}
								</span>
							</div>

							<div
								style={{
									height: 18,
									borderRadius: 6,
									backgroundColor: palette.mutedBg,
									border: `1px solid ${palette.borderSubtle}`,
									position: "relative",
									overflow: "hidden",
								}}
							>
								<div
									style={{
										position: "absolute",
										top: 1,
										bottom: 1,
										left: `${stage.startPct}%`,
										width: `${(stage.widthPct * prog).toFixed(2)}%`,
										borderRadius: 4,
										backgroundColor: palette.cite,
									}}
								/>
								{running && (
									<div
										style={{
											position: "absolute",
											top: 0,
											bottom: 0,
											left: `${(stage.startPct + stage.widthPct * prog).toFixed(2)}%`,
											width: 2.5,
											backgroundColor: palette.fg,
											boxShadow: `0 0 8px ${alpha(palette.cite, 0.7)}`,
										}}
									/>
								)}
							</div>

							<span
								style={{
									fontFamily: FONT_MONO,
									fontSize: 13.5,
									fontWeight: done ? 650 : 500,
									color: done ? palette.fg : palette.mutedFg,
									textAlign: "right",
									fontVariantNumeric: "tabular-nums",
								}}
							>
								{curLabel}
							</span>
						</div>
					);
				})}
			</div>

			{/* Honest Model Token Usage Ledger */}
			<div
				style={{
					position: "relative",
					zIndex: 2,
					flex: 1,
					backgroundColor: palette.card,
					border: `1px solid ${palette.border}`,
					borderRadius: 14,
					padding: "22px 24px",
					boxShadow: palette.shadowSm,
					display: "flex",
					flexDirection: "column",
					justifyContent: "space-between",
					gap: 14,
				}}
			>
				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
					}}
				>
					<span style={{ fontSize: 15.5, fontWeight: 650 }}>
						{pickText(locale, "模型 Token 用量", "Model Token Usage")}
					</span>
					<span
						style={{
							fontFamily: FONT_MONO,
							fontSize: 12,
							color: palette.mutedFg,
						}}
					>
						{pickText(locale, "已上报 · 仅计 LLM", "Reported · LLM calls only")}
					</span>
				</div>

				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(3, 1fr)",
						gap: 14,
					}}
				>
					{[
						[
							pickText(locale, "输入 Tokens", "Input tokens"),
							inputTokens.toLocaleString(),
							false,
						],
						[
							pickText(locale, "输出 Tokens", "Output tokens"),
							outputTokens.toLocaleString(),
							false,
						],
						[
							pickText(locale, "合计 Tokens", "Total tokens"),
							totalTokens.toLocaleString(),
							true,
						],
					].map(([label, value, accent]) => (
						<div
							key={String(label)}
							style={{
								backgroundColor: accent && allDone ? palette.citeBg : palette.bg,
								border: `1px solid ${accent && allDone ? palette.citeBorder : palette.borderSubtle}`,
								borderRadius: 11,
								padding: "13px 16px",
							}}
						>
							<div style={{ fontSize: 12, color: palette.mutedFg }}>
								{String(label)}
							</div>
							<div
								style={{
									fontFamily: FONT_MONO,
									fontSize: 24,
									fontWeight: 700,
									color: accent && allDone ? palette.cite : palette.fg,
									marginTop: 5,
									fontVariantNumeric: "tabular-nums",
								}}
							>
								{String(value)}
							</div>
						</div>
					))}
				</div>

				<div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
					{[
						{
							stage: "judge",
							model: "qwen3-32b",
							io: "1,020 in / 94 out",
							p: ramp(frame, 62, 16, EASE.snappy),
						},
						{
							stage: "generate",
							model: "gpt-4.1-mini",
							io: "1,820 in / 292 out",
							p: ramp(frame, 108, 16, EASE.snappy),
						},
					].map((call) => (
						<div
							key={call.stage}
							style={{
								display: "flex",
								justifyContent: "space-between",
								alignItems: "center",
								padding: "11px 15px",
								borderRadius: 9,
								backgroundColor: palette.mutedBg,
								border: `1px solid ${palette.borderSubtle}`,
								fontFamily: FONT_MONO,
								fontSize: 13.5,
								opacity: mix(0.28, 1, call.p),
								transform: `translateX(${((1 - call.p) * -12).toFixed(2)}px)`,
							}}
						>
							<span style={{ fontWeight: 650 }}>
								{call.stage} · {call.model}
							</span>
							<span style={{ color: palette.mutedFg }}>{call.io}</span>
						</div>
					))}
				</div>

				<div style={{ fontSize: 12.5, color: palette.mutedFg }}>
					{pickText(
						locale,
						"未上报字段保持为空；Token 用量不直接等同于计费金额。",
						"Unreported fields remain blank. Token counts are not billing costs.",
					)}
				</div>
			</div>

			<FilmGrain opacity={theme === "dark" ? 0.04 : 0.022} />
		</AbsoluteFill>
	);
};
