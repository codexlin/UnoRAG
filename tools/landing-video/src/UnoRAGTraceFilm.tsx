import React from "react";
import {
	AbsoluteFill,
	Easing,
	interpolate,
	useCurrentFrame,
} from "remotion";
import {
	type FilmProps,
	FONT_MONO,
	FONT_SANS,
	getPalette,
	pickText,
} from "./theme";

const EASE_OUT = Easing.bezier(0.22, 1, 0.36, 1);

export const UnoRAGTraceFilm: React.FC<FilmProps> = ({ locale, theme }) => {
	const frame = useCurrentFrame();
	const palette = getPalette(theme);

	const stages = [
		{
			name: pickText(locale, "权限范围解析", "Access scope check"),
			ms: "18ms",
			startPct: 0,
			widthPct: 3.5,
			startFrame: 12,
			endFrame: 28,
		},
		{
			name: pickText(locale, "混合检索与重排", "Hybrid retrieval & rerank"),
			ms: "294ms",
			startPct: 3.5,
			widthPct: 12.5,
			startFrame: 28,
			endFrame: 62,
		},
		{
			name: pickText(locale, "证据充分性判断", "Evidence judge"),
			ms: "1.42s",
			startPct: 16,
			widthPct: 30,
			startFrame: 62,
			endFrame: 106,
		},
		{
			name: pickText(locale, "带引用回答生成", "Cited answer generation"),
			ms: "2.81s",
			startPct: 46,
			widthPct: 54,
			startFrame: 106,
			endFrame: 160,
		},
	];

	const tokenProg = interpolate(frame, [40, 130], [0.55, 1], {
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
		easing: EASE_OUT,
	});
	const inputTokens = Math.round(2840 * tokenProg);
	const outputTokens = Math.round(386 * tokenProg);
	const totalTokens = inputTokens + outputTokens;

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
			}}
		>
			{/* Header */}
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					borderBottom: `1px solid ${palette.border}`,
					paddingBottom: 18,
				}}
			>
				<div>
					<div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>
						{pickText(locale, "请求链路详情", "Request Trace Detail")}
					</div>
					<div style={{ fontSize: 13.5, color: palette.mutedFg, marginTop: 4, fontFamily: FONT_MONO }}>
						req_9f42c8a1 · Ask · hybrid + rerank
					</div>
				</div>
				<span
					style={{
						padding: "6px 14px",
						borderRadius: 999,
						backgroundColor: palette.citeBg,
						border: `1px solid ${palette.citeBorder}`,
						color: palette.cite,
						fontSize: 13,
						fontWeight: 600,
					}}
				>
					{pickText(locale, "✓ 已完成 · 2 处引用", "✓ Completed · 2 citations")}
				</span>
			</div>

			{/* Metadata Grid */}
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(4, 1fr)",
					gap: 12,
				}}
			>
				{[
					[pickText(locale, "问题类型", "Query type"), "fact"],
					[pickText(locale, "检索模式", "Retrieval"), "hybrid"],
					[pickText(locale, "重排", "Rerank"), pickText(locale, "已启用", "Enabled")],
					[pickText(locale, "拒答原因", "Refusal"), "—"],
				].map(([k, v]) => (
					<div
						key={k}
						style={{
							backgroundColor: palette.card,
							border: `1px solid ${palette.border}`,
							borderRadius: 10,
							padding: "12px 14px",
						}}
					>
						<div style={{ fontSize: 12, color: palette.mutedFg }}>{k}</div>
						<div style={{ fontSize: 15, fontWeight: 600, fontFamily: FONT_MONO, marginTop: 4 }}>
							{v}
						</div>
					</div>
				))}
			</div>

			{/* Stage Waterfall */}
			<div
				style={{
					backgroundColor: palette.card,
					border: `1px solid ${palette.border}`,
					borderRadius: 12,
					padding: "20px 22px",
					display: "flex",
					flexDirection: "column",
					gap: 16,
					boxShadow: palette.shadowSm,
				}}
			>
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
					<div>
						<span style={{ fontSize: 15, fontWeight: 600 }}>
							{pickText(locale, "阶段耗时瀑布", "Stage Timing Breakdown")}
						</span>
						<span style={{ fontSize: 12.5, color: palette.mutedFg, marginLeft: 10 }}>
							{pickText(locale, "4 步 · 顺序累计", "4 stages · sequential sum")}
						</span>
					</div>
					<span style={{ fontFamily: FONT_MONO, fontSize: 15, fontWeight: 600 }}>
						4.54s
					</span>
				</div>

				{stages.map((stage) => {
					const prog = interpolate(frame, [stage.startFrame, stage.endFrame], [0, 1], {
						extrapolateLeft: "clamp",
						extrapolateRight: "clamp",
						easing: EASE_OUT,
					});
					const done = frame >= stage.endFrame;
					return (
						<div
							key={stage.name}
							style={{
								display: "grid",
								gridTemplateColumns: "220px 1fr 78px",
								alignItems: "center",
								gap: 16,
							}}
						>
							<div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
								<span style={{ color: done ? palette.cite : palette.mutedFg, fontWeight: 700 }}>
									{done ? "✓" : "○"}
								</span>
								<span style={{ fontWeight: 500 }}>{stage.name}</span>
							</div>
							<div
								style={{
									height: 16,
									borderRadius: 5,
									backgroundColor: palette.mutedBg,
									position: "relative",
									overflow: "hidden",
								}}
							>
								<div
									style={{
										position: "absolute",
										top: 0,
										bottom: 0,
										left: `${stage.startPct}%`,
										width: `${stage.widthPct * prog}%`,
										borderRadius: 4,
										backgroundColor: palette.cite,
									}}
								/>
							</div>
							<span
								style={{
									fontFamily: FONT_MONO,
									fontSize: 13,
									color: palette.mutedFg,
									textAlign: "right",
								}}
							>
								{prog > 0.05 ? stage.ms : "—"}
							</span>
						</div>
					);
				})}
			</div>

			{/* Model Usage Ledger */}
			<div
				style={{
					flex: 1,
					backgroundColor: palette.card,
					border: `1px solid ${palette.border}`,
					borderRadius: 12,
					padding: "20px 22px",
					display: "flex",
					flexDirection: "column",
					justifyContent: "space-between",
					gap: 14,
				}}
			>
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
					<span style={{ fontSize: 15, fontWeight: 600 }}>
						{pickText(locale, "模型 Token 用量", "Model Token Usage")}
					</span>
					<span style={{ fontSize: 12, color: palette.mutedFg }}>
						{pickText(locale, "已上报 · 仅计 LLM", "Reported · LLM calls only")}
					</span>
				</div>

				<div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
					{[
						[pickText(locale, "输入 Tokens", "Input tokens"), inputTokens.toLocaleString()],
						[pickText(locale, "输出 Tokens", "Output tokens"), outputTokens.toLocaleString()],
						[pickText(locale, "合计 Tokens", "Total tokens"), totalTokens.toLocaleString()],
					].map(([label, value]) => (
						<div
							key={label}
							style={{
								backgroundColor: palette.bg,
								border: `1px solid ${palette.borderSubtle}`,
								borderRadius: 10,
								padding: "12px 16px",
							}}
						>
							<div style={{ fontSize: 12, color: palette.mutedFg }}>{label}</div>
							<div
								style={{
									fontFamily: FONT_MONO,
									fontSize: 22,
									fontWeight: 600,
									marginTop: 4,
									fontVariantNumeric: "tabular-nums",
								}}
							>
								{value}
							</div>
						</div>
					))}
				</div>

				<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
					{[
						{
							stage: "judge",
							model: "qwen3-32b",
							io: "1,020 in / 94 out",
						},
						{
							stage: "generate",
							model: "gpt-4.1-mini",
							io: "1,820 in / 292 out",
						},
					].map((call) => (
						<div
							key={call.stage}
							style={{
								display: "flex",
								justifyContent: "space-between",
								alignItems: "center",
								padding: "10px 14px",
								borderRadius: 8,
								backgroundColor: palette.mutedBg,
								fontFamily: FONT_MONO,
								fontSize: 13,
								opacity: tokenProg,
							}}
						>
							<span style={{ fontWeight: 600 }}>
								{call.stage} · {call.model}
							</span>
							<span style={{ color: palette.mutedFg }}>{call.io}</span>
						</div>
					))}
				</div>

				<div style={{ fontSize: 12, color: palette.mutedFg }}>
					{pickText(
						locale,
						"未上报字段保持为空；Token 用量不直接等同于计费金额。",
						"Unreported fields remain blank. Token counts are not billing costs.",
					)}
				</div>
			</div>
		</AbsoluteFill>
	);
};
