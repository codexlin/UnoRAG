import React from "react";
import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
} from "remotion";
import {
	CornerBrackets,
	EASE,
	FilmFonts,
	FilmGrain,
	type FilmPalette,
	type FilmProps,
	FONT_MONO,
	FONT_SANS,
	SwissStage,
	UnoMarkImg,
	alpha,
	clamp,
	getPalette,
	mix,
	pickText,
	ramp,
	springAt,
} from "./theme";

const CH1_END = 120; // 0-4s: Cited answer (scanline-annotate-focus)
const CH2_END = 240; // 4-8s: Retrieval & check (hybrid + evidence judge)
// 8-12s (240-360f): Access scope (chip-grid-single-select-blackout)

const TopWorkspaceBar: React.FC<{
	locale: FilmProps["locale"];
	theme: FilmProps["theme"];
	palette: FilmPalette;
	chapterIdx: 0 | 1 | 2;
	frame: number;
}> = ({ locale, theme, palette, chapterIdx, frame }) => {
	const badges = [
		pickText(locale, "01 · 扫描核验引用", "01 · CITATION SCAN"),
		pickText(locale, "02 · 混合检索与证据判断", "02 · HYBRID + JUDGE"),
		pickText(locale, "03 · 检索前 ACL 隔离", "03 · PRE-RETRIEVAL ACL"),
	];
	const dotPulse = 0.55 + 0.45 * Math.sin(frame / 4);

	return (
		<div
			style={{
				height: 54,
				padding: "0 28px",
				borderBottom: `1px solid ${palette.border}`,
				backgroundColor: palette.card,
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				position: "relative",
				zIndex: 10,
			}}
		>
			<div style={{ display: "flex", alignItems: "center", gap: 11 }}>
				<UnoMarkImg theme={theme} size={22} />
				<span
					style={{
						fontSize: 15,
						fontWeight: 650,
						color: palette.fg,
						letterSpacing: "-0.02em",
					}}
				>
					UnoRAG
				</span>
				<span
					style={{
						width: 1,
						height: 14,
						backgroundColor: palette.border,
						margin: "0 4px",
					}}
				/>
				<span style={{ fontSize: 13, color: palette.mutedFg }}>
					{pickText(
						locale,
						"工作区 / 内部制度库",
						"Workspace / Internal Policies",
					)}
				</span>
			</div>

			<div style={{ display: "flex", alignItems: "center", gap: 12 }}>
				<div
					style={{
						display: "inline-flex",
						alignItems: "center",
						gap: 8,
						padding: "4px 12px",
						borderRadius: 999,
						backgroundColor: palette.citeBg,
						border: `1px solid ${palette.citeBorder}`,
						color: palette.cite,
						fontSize: 12,
						fontWeight: 650,
						fontFamily: FONT_MONO,
						letterSpacing: "0.02em",
					}}
				>
					<span
						style={{
							width: 7,
							height: 7,
							borderRadius: 99,
							backgroundColor: palette.cite,
							opacity: dotPulse,
						}}
					/>
					<span>{badges[chapterIdx]}</span>
				</div>
			</div>
		</div>
	);
};

/**
 * Chapter 1 (0-4s, 0..120f): scanline-annotate-focus on Cited Answer <-> Verbatim Source Excerpt.
 * Populated at frame 0 (never blank!) with crisp green scanline sweep + 3 locking corner brackets.
 */
const SceneCitationScan: React.FC<{
	locale: FilmProps["locale"];
	palette: FilmPalette;
	frame: number;
}> = ({ locale, palette, frame }) => {
	const local = Math.max(0, frame);
	const push = 1 + 0.018 * ramp(local, 0, 112, EASE.swift);

	// Scanline runs y=72..680 across f6..f56
	const scanP = ramp(local, 6, 50, (t) => t); // linear mechanical scan!
	const scanY = mix(72, 690, scanP);
	const lineOn =
		ramp(local, 3, 5, EASE.out) * (1 - ramp(local, 56, 8, EASE.out));

	const answerFull = pickText(
		locale,
		"根据《员工手册》第 3 章规定，病假诊断证明须于返岗后三个工作日内在考勤系统补交。",
		"According to Chapter 3 of the Employee Handbook, submit your hospital medical certificate within three business days of returning to work.",
	);
	const minChars = Math.floor(answerFull.length * 0.72);
	const charCount = Math.floor(
		interpolate(local, [0, 20], [minChars, answerFull.length], clamp),
	);
	const visibleAnswer = answerFull.slice(0, charCount);

	// 3 bracket lock triggers aligned with scanline passage
	const fLock1 = 28; // Citation [1] + connector beam
	const fLock2 = 34; // Version snapshot pinned
	const fLock3 = 46; // Verbatim source excerpt verified

	const beamP = ramp(local, fLock1 + 2, 18, EASE.snappy);
	const hlSweep = interpolate(local, [fLock3 - 4, fLock3 + 22], [18, 100], {
		...clamp,
		easing: EASE.out,
	});
	const lockedCount =
		(local >= fLock1 ? 1 : 0) +
		(local >= fLock2 ? 1 : 0) +
		(local >= fLock3 ? 1 : 0);

	const tagStyle = (fireAt: number): React.CSSProperties => {
		const pop = ramp(local, fireAt + 3, 8, EASE.snappy);
		return {
			display: "inline-flex",
			alignItems: "center",
			gap: 6,
			padding: "5px 12px",
			borderRadius: 7,
			backgroundColor: palette.cite,
			color: palette.citeSolidFg,
			fontFamily: FONT_MONO,
			fontSize: 13.5,
			fontWeight: 700,
			letterSpacing: "0.02em",
			opacity: pop,
			transform: `translateY(${((1 - pop) * 7).toFixed(2)}px)`,
			boxShadow: `0 8px 18px -8px ${alpha("#092416", 0.45)}`,
			whiteSpace: "nowrap",
		};
	};

	return (
		<div
			style={{
				position: "relative",
				width: 1440,
				height: 756,
				transform: `scale(${push.toFixed(5)})`,
				transformOrigin: "50% 48%",
			}}
		>
			{/* Top telemetry micro-bar */}
			<div
				style={{
					position: "absolute",
					left: 56,
					right: 56,
					top: 26,
					height: 32,
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					fontFamily: FONT_MONO,
					fontSize: 13,
					color: palette.mutedFg,
				}}
			>
				<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
					<span
						style={{
							color: lockedCount === 3 ? palette.cite : palette.fg,
							fontWeight: 700,
						}}
					>
						{lockedCount === 3
							? pickText(locale, "✓ 证据链路已全部核验", "✓ EVIDENCE CHAIN VERIFIED")
							: pickText(locale, "正在扫描引用与原文定位…", "VERIFYING CITATION & SPAN…")}
					</span>
					<span style={{ color: palette.dimFg }}>·</span>
					<span>
						{pickText(locale, "仅检索当前成员授权范围", "Caller ACL enforced")}
					</span>
				</div>
				<div style={{ display: "flex", alignItems: "center", gap: 12 }}>
					<div
						style={{
							width: 112,
							height: 4,
							borderRadius: 2,
							backgroundColor: palette.border,
							overflow: "hidden",
						}}
					>
						<div
							style={{
								width: `${Math.round(scanP * 100)}%`,
								height: "100%",
								backgroundColor: palette.cite,
							}}
						/>
					</div>
					<span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 650 }}>
						<span style={{ color: palette.cite }}>0{lockedCount}</span> / 03
					</span>
				</div>
			</div>

			{/* Left Card: Grounded Answer (exact fixed height=374 so zh & en align identically!) */}
			<div
				style={{
					position: "absolute",
					left: 56,
					top: 152,
					width: 634,
					height: 374,
					boxSizing: "border-box",
					backgroundColor: palette.card,
					border: `1px solid ${palette.border}`,
					borderRadius: 16,
					padding: "24px 28px",
					boxShadow: palette.shadow,
					display: "flex",
					flexDirection: "column",
					justifyContent: "space-between",
					gap: 14,
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						paddingBottom: 14,
						borderBottom: `1px solid ${palette.borderSubtle}`,
					}}
				>
					<span
						style={{
							fontSize: 13.5,
							fontWeight: 650,
							color: palette.mutedFg,
						}}
					>
						{pickText(locale, "Ask 有据回答", "Grounded Answer")}
					</span>
					<span
						style={{
							fontSize: 12.5,
							fontWeight: 650,
							color: palette.cite,
							backgroundColor: palette.citeBg,
							border: `1px solid ${palette.citeBorder}`,
							padding: "4px 11px",
							borderRadius: 999,
						}}
					>
						{pickText(locale, "✓ 1 处授权引用", "✓ 1 authorized citation")}
					</span>
				</div>

				<div
					style={{
						padding: "11px 14px",
						borderRadius: 10,
						backgroundColor: palette.mutedBg,
						fontSize: 14.5,
						fontWeight: 550,
						color: palette.fg,
					}}
				>
					{pickText(
						locale,
						"问：病假材料要在何时补交？",
						"Q: When should I submit the remaining sick leave documents?",
					)}
				</div>

				<div
					style={{
						fontSize: locale === "zh-CN" ? 22 : 21,
						lineHeight: 1.62,
						fontWeight: 550,
						color: palette.fg,
						minHeight: 118,
					}}
				>
					{visibleAnswer}
					<span
						style={{
							display: "inline-flex",
							alignItems: "center",
							justifyContent: "center",
							marginLeft: 8,
							width: 28,
							height: 28,
							borderRadius: 6,
							fontFamily: FONT_MONO,
							fontSize: 14,
							fontWeight: 700,
							verticalAlign: "middle",
							backgroundColor: palette.evidenceBg,
							border: `1.5px solid ${palette.evidenceBorder}`,
							color: palette.evidence,
							transform: `scale(${mix(0.88, 1, springAt(local, 14)).toFixed(3)})`,
						}}
					>
						1
					</span>
				</div>

				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						paddingTop: 12,
						borderTop: `1px solid ${palette.borderSubtle}`,
						fontSize: 13,
						color: palette.mutedFg,
					}}
				>
					<span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
						<span style={{ color: palette.cite, fontWeight: 700 }}>✓</span>
						{pickText(
							locale,
							"基于当次生效版本生成，支持逐句核对",
							"Bound to active authorized version",
						)}
					</span>
					<span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
						{pickText(locale, "证据依据 · 1 份文档", "Evidence · 1 source")}
					</span>
				</div>
			</div>

			{/* Crisp trace connector from Answer to Sources */}
			<svg
				width={98}
				height={60}
				viewBox="0 0 98 60"
				style={{
					position: "absolute",
					left: 690,
					top: 309,
					pointerEvents: "none",
				}}
			>
				<line
					x1={4}
					y1={30}
					x2={4 + 86 * beamP}
					y2={30}
					stroke={palette.cite}
					strokeWidth={2.5}
					strokeLinecap="round"
				/>
				<circle
					cx={4 + 86 * beamP}
					cy={30}
					r={4.5}
					fill={palette.cite}
					opacity={beamP > 0.05 ? 1 : 0}
				/>
			</svg>

			{/* Right Card: Verbatim Source Excerpt Inspector (exact fixed height=374 matching left card!) */}
			<div
				style={{
					position: "absolute",
					left: 786,
					top: 152,
					width: 598,
					height: 374,
					boxSizing: "border-box",
					backgroundColor: palette.card,
					border: `1.5px solid ${local >= fLock2 ? palette.citeBorder : palette.border}`,
					borderRadius: 16,
					padding: "24px 28px",
					boxShadow: palette.shadow,
					display: "flex",
					flexDirection: "column",
					justifyContent: "space-between",
					gap: 12,
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
					}}
				>
					<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
						<span
							style={{
								display: "inline-flex",
								alignItems: "center",
								justifyContent: "center",
								width: 24,
								height: 24,
								borderRadius: 5,
								fontFamily: FONT_MONO,
								fontSize: 13,
								fontWeight: 700,
								backgroundColor: palette.evidenceBg,
								border: `1px solid ${palette.evidenceBorder}`,
								color: palette.evidence,
							}}
						>
							1
						</span>
						<span
							style={{
								fontSize: 15,
								fontWeight: 650,
								color: palette.fg,
							}}
						>
							{pickText(locale, "员工手册", "Employee Handbook")}
						</span>
					</div>
					<span
						style={{
							fontFamily: FONT_MONO,
							fontSize: 12,
							color: palette.mutedFg,
						}}
					>
						{pickText(locale, "第 3 章 · §3.2", "Chapter 3 · §3.2")}
					</span>
				</div>

				{/* Immutable version snapshot strip */}
				<div
					style={{
						padding: "10px 14px",
						borderRadius: 9,
						backgroundColor: palette.mutedBg,
						border: `1px solid ${palette.borderSubtle}`,
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						fontFamily: FONT_MONO,
						fontSize: 12.5,
					}}
				>
					<span style={{ color: palette.mutedFg }}>
						{pickText(locale, "当次版本快照", "Version snapshot")}
					</span>
					<span style={{ color: palette.fg, fontWeight: 600 }}>
						729c3fd7 · employee-handbook.md
					</span>
				</div>

				{/* Source excerpt body (exact height=170 for zh/en alignment) */}
				<div
					style={{
						height: 170,
						boxSizing: "border-box",
						borderRadius: 11,
						backgroundColor: palette.mutedBg,
						border: `1px solid ${palette.border}`,
						padding: "16px 20px",
						fontSize: 16,
						lineHeight: 1.72,
						color: palette.fg,
					}}
				>
					<div
						style={{
							fontSize: 12,
							fontWeight: 650,
							color: palette.mutedFg,
							marginBottom: 8,
							letterSpacing: "0.02em",
						}}
					>
						{pickText(locale, "来源片段", "Source excerpt")}
					</div>
					{pickText(
						locale,
						"“病假须提供二级甲等以上医院出具的诊断证明，须于",
						'"Sick leave requires a medical certificate from an accredited hospital. Submit all documents ',
					)}
					<span
						style={{
							backgroundImage: `linear-gradient(90deg, ${palette.evidenceBg} ${hlSweep}%, transparent ${hlSweep}%)`,
							color: palette.evidence,
							fontWeight: 650,
							padding: "2px 6px",
							borderRadius: 4,
						}}
					>
						{pickText(
							locale,
							"返岗后三个工作日内",
							"within three business days of returning to work",
						)}
					</span>
					{pickText(locale, "补交完整材料。”", '."')}
				</div>

				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						fontSize: 13,
						color: palette.mutedFg,
					}}
				>
					<span style={{ color: palette.cite, fontWeight: 650 }}>
						{pickText(locale, "✓ 原文片段已定位", "✓ Source span verified")}
					</span>
					<span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
						{pickText(locale, "权限校验通过", "ACL verified")}
					</span>
				</div>
			</div>

			{/* 3 Shotcraft Locking Brackets & Tags — laser-tight to fixed card/box geometry (both zh & en!) */}
			<CornerBrackets
				x={48}
				y={144}
				w={650}
				h={390}
				frame={local}
				fireAt={fLock1}
				color={palette.cite}
			/>
			{local >= fLock1 + 3 && (
				<div style={{ position: "absolute", left: 56, top: 554 }}>
					<div style={tagStyle(fLock1)}>
						{pickText(locale, "引用 [1] · 已绑定原文", "CITATION [1] · LINKED")}
					</div>
				</div>
			)}

			<CornerBrackets
				x={808}
				y={220}
				w={554}
				h={48}
				frame={local}
				fireAt={fLock2}
				color={palette.cite}
				armLen={14}
			/>
			{local >= fLock2 + 3 && (
				<div style={{ position: "absolute", right: 56, top: 100 }}>
					<div style={tagStyle(fLock2)}>
						{pickText(locale, "版本快照 · 不可变锁定", "SNAPSHOT · PINNED")}
					</div>
				</div>
			)}

			<CornerBrackets
				x={808}
				y={282}
				w={554}
				h={180}
				frame={local}
				fireAt={fLock3}
				color={palette.cite}
				armLen={18}
			/>
			{local >= fLock3 + 3 && (
				<div style={{ position: "absolute", right: 56, top: 554 }}>
					<div style={tagStyle(fLock3)}>
						{pickText(locale, "原文片段 · 核验通过", "EXCERPT · VERIFIED")}
					</div>
				</div>
			)}

			{/* Active Emerald Scanline + Dotted Radar Trail + Y Readout */}
			{lineOn > 0.01 && (
				<>
					<div
						style={{
							position: "absolute",
							left: 36,
							right: 36,
							top: scanY - 105,
							height: 105,
							opacity: lineOn,
							background: `linear-gradient(180deg, ${alpha(palette.cite, 0)} 0%, ${alpha(palette.cite, 0.05)} 55%, ${alpha(palette.cite, 0.14)} 100%)`,
							pointerEvents: "none",
						}}
					/>
					<div
						style={{
							position: "absolute",
							left: 36,
							right: 36,
							top: scanY - 72,
							height: 72,
							opacity: lineOn * 0.72,
							backgroundImage: `radial-gradient(circle, ${alpha(palette.cite, 0.55)} 1.2px, transparent 1.8px)`,
							backgroundSize: "16px 16px",
							WebkitMaskImage: "linear-gradient(180deg, transparent, #000)",
							maskImage: "linear-gradient(180deg, transparent, #000)",
							pointerEvents: "none",
						}}
					/>
					<div
						style={{
							position: "absolute",
							left: 36,
							right: 36,
							top: scanY - 1.5,
							height: 2.5,
							opacity: lineOn,
							backgroundColor: palette.cite,
							boxShadow: `0 0 12px ${alpha(palette.cite, 0.5)}`,
							pointerEvents: "none",
						}}
					/>
					<div
						style={{
							position: "absolute",
							left: 56,
							top: scanY - 24,
							fontFamily: FONT_MONO,
							fontSize: 12,
							fontWeight: 700,
							color: palette.cite,
							opacity: lineOn,
							fontVariantNumeric: "tabular-nums",
						}}
					>
						Y {String(Math.round(scanY)).padStart(4, "0")}
					</div>
				</>
			)}
		</div>
	);
};

/**
 * Chapter 2 (4-8s, 120..240f): Hybrid Retrieval (BM25 + Vector + Rerank) & Evidence Judge.
 * Strictly honors DESIGN.md: reports honest rank & score without fake 0-100% probability bars.
 */
const SceneRetrievalJudge: React.FC<{
	locale: FilmProps["locale"];
	palette: FilmPalette;
	frame: number;
}> = ({ locale, palette, frame }) => {
	const local = Math.max(0, frame - CH1_END);

	const candidates = [
		{
			rank: "#1",
			doc: pickText(locale, "员工手册 · 第 3 章 请假制度", "Employee Handbook · §3.2 Leave Policy"),
			file: "employee-handbook.md",
			channel: "BM25 + Vector",
			score: "0.94",
			selected: true,
			cue: 6,
		},
		{
			rank: "#2",
			doc: pickText(locale, "考勤与休假规范 · 第 4 页", "Attendance Policy · Page 4"),
			file: "leave-attendance-policy.pdf",
			channel: "Vector",
			score: "0.72",
			selected: false,
			cue: 14,
		},
		{
			rank: "#3",
			doc: pickText(locale, "员工手册 · §3.5 考勤申诉", "Employee Handbook · §3.5 Appeal"),
			file: "employee-handbook.md",
			channel: "BM25",
			score: "0.56",
			selected: false,
			cue: 22,
		},
	];

	const checks = [
		{
			label: pickText(locale, "授权范围核对", "Caller ACL matched"),
			detail: pickText(locale, "工作区 + 库 + 文档级通过", "Workspace + Library + Doc"),
			cue: 36,
		},
		{
			label: pickText(locale, "原文事实覆盖", "Claim grounded in excerpt"),
			detail: pickText(locale, "关键时限与主语一致", "Deadline & policy aligned"),
			cue: 48,
		},
		{
			label: pickText(locale, "多源冲突检查", "Cross-source conflict check"),
			detail: pickText(locale, "未检测到矛盾条款", "Zero conflicting clauses"),
			cue: 60,
		},
	];

	const hlSweep = interpolate(local, [32, 68], [0, 100], {
		...clamp,
		easing: EASE.out,
	});
	const verdictP = springAt(local, 66, { damping: 16, stiffness: 210, mass: 0.9 });

	return (
		<div
			style={{
				width: 1440,
				height: 756,
				padding: "36px 56px",
				boxSizing: "border-box",
				display: "flex",
				flexDirection: "column",
				justifyContent: "center",
				gap: 24,
			}}
		>
			{/* Query header */}
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					padding: "16px 24px",
					borderRadius: 14,
					border: `1px solid ${palette.border}`,
					backgroundColor: palette.card,
					boxShadow: palette.shadowSm,
				}}
			>
				<div style={{ display: "flex", alignItems: "center", gap: 14 }}>
					<span
						style={{
							fontFamily: FONT_MONO,
							fontSize: 12.5,
							fontWeight: 700,
							padding: "5px 11px",
							borderRadius: 7,
							backgroundColor: palette.mutedBg,
							color: palette.mutedFg,
						}}
					>
						{pickText(locale, "检索提问", "QUERY")}
					</span>
					<span style={{ fontSize: 20, fontWeight: 600, color: palette.fg }}>
						{pickText(
							locale,
							"病假材料要在何时补交？",
							"When should I submit the remaining sick leave documents?",
						)}
					</span>
				</div>
				<span
					style={{
						fontFamily: FONT_MONO,
						fontSize: 12.5,
						fontWeight: 600,
						color: palette.cite,
						padding: "5px 12px",
						borderRadius: 8,
						backgroundColor: palette.citeBg,
						border: `1px solid ${palette.citeBorder}`,
					}}
				>
					{pickText(locale, "混合检索 + Rerank", "Hybrid Retrieval + Rerank")}
				</span>
			</div>

			<div
				style={{
					display: "grid",
					gridTemplateColumns: "1fr 1.05fr",
					gap: 26,
					alignItems: "stretch",
				}}
			>
				{/* Left: Ranked Candidates (honest rank + rerank score, no fake probability bar) */}
				<div
					style={{
						backgroundColor: palette.card,
						border: `1px solid ${palette.border}`,
						borderRadius: 16,
						padding: 24,
						boxShadow: palette.shadow,
						display: "flex",
						flexDirection: "column",
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
						<span
							style={{
								fontSize: 14,
								fontWeight: 650,
								color: palette.fg,
							}}
						>
							{pickText(locale, "重排候选片段", "Reranked Candidate Excerpts")}
						</span>
						<span
							style={{
								fontFamily: FONT_MONO,
								fontSize: 12,
								color: palette.mutedFg,
							}}
						>
							{pickText(locale, "按重排分值排序", "Ordered by rerank score")}
						</span>
					</div>

					{candidates.map((item) => {
						const p = ramp(local, item.cue, 16, EASE.snappy);
						const focusLock =
							item.selected ? ramp(local, 34, 10, EASE.out) : 0;
						const dimOthers =
							!item.selected ? mix(1, 0.52, ramp(local, 36, 12, EASE.out)) : 1;
						return (
							<div
								key={item.rank}
								style={{
									padding: "16px 18px",
									borderRadius: 12,
									border: `1.5px solid ${item.selected && focusLock > 0.2 ? palette.cite : item.selected ? palette.evidenceBorder : palette.border}`,
									backgroundColor:
										item.selected && focusLock > 0.2
											? palette.citeBg
											: palette.bg,
									opacity: p * dimOthers,
									transform: `translateX(${((1 - p) * -28).toFixed(2)}px)`,
									display: "flex",
									flexDirection: "column",
									gap: 8,
								}}
							>
								<div
									style={{
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center",
										gap: 12,
									}}
								>
									<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
										<span
											style={{
												fontFamily: FONT_MONO,
												fontSize: 12.5,
												fontWeight: 700,
												padding: "2px 8px",
												borderRadius: 6,
												backgroundColor: item.selected
													? palette.cite
													: palette.mutedBg,
												color: item.selected
													? palette.citeSolidFg
													: palette.mutedFg,
											}}
										>
											{item.rank}
										</span>
										<span
											style={{
												fontSize: 15,
												fontWeight: 650,
												color: palette.fg,
											}}
										>
											{item.doc}
										</span>
									</div>
									<span
										style={{
											fontFamily: FONT_MONO,
											fontSize: 13.5,
											fontWeight: 700,
											color: item.selected ? palette.cite : palette.mutedFg,
										}}
									>
										{item.score}
									</span>
								</div>
								<div
									style={{
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center",
										fontFamily: FONT_MONO,
										fontSize: 12,
										color: palette.mutedFg,
									}}
								>
									<span>{item.file}</span>
									<span>{item.channel}</span>
								</div>
							</div>
						);
					})}
				</div>

				{/* Right: Evidence Judge Panel */}
				<div
					style={{
						backgroundColor: palette.card,
						border: `1px solid ${palette.border}`,
						borderRadius: 16,
						padding: 24,
						boxShadow: palette.shadow,
						display: "flex",
						flexDirection: "column",
						justifyContent: "space-between",
						gap: 16,
					}}
				>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
						}}
					>
						<span style={{ fontSize: 14, fontWeight: 650, color: palette.fg }}>
							{pickText(locale, "证据充分性判断", "Evidence Groundedness Judge")}
						</span>
						<span
							style={{
								fontSize: 12.5,
								fontWeight: 700,
								padding: "5px 12px",
								borderRadius: 999,
								backgroundColor: palette.cite,
								color: palette.citeSolidFg,
								opacity: verdictP,
								transform: `scale(${mix(0.88, 1, verdictP).toFixed(3)})`,
							}}
						>
							{pickText(locale, "✓ 允许作答", "✓ Grounded · Pass")}
						</span>
					</div>

					{/* Highlighted excerpt under judgment */}
					<div
						style={{
							borderRadius: 11,
							border: `1px solid ${palette.border}`,
							backgroundColor: palette.mutedBg,
							padding: "16px 18px",
							fontSize: 16,
							lineHeight: 1.72,
							color: palette.fg,
						}}
					>
						{pickText(
							locale,
							"员工因病连续休假超过两日的，须提供二级甲等以上医院出具的诊断证明，并于",
							"Sick leave over two consecutive days requires a medical certificate from an accredited hospital. Submit all documents ",
						)}
						<span
							style={{
								padding: "2px 6px",
								borderRadius: 5,
								fontWeight: 650,
								color: palette.evidence,
								backgroundImage: `linear-gradient(90deg, ${palette.evidenceBg} ${hlSweep}%, transparent ${hlSweep}%)`,
							}}
						>
							{pickText(
								locale,
								"返岗后三个工作日内",
								"within three business days of returning to work",
							)}
						</span>
						{pickText(locale, "在考勤系统补交完整材料。", " in the attendance portal.")}
					</div>

					{/* 3 Sequential Groundedness Checkpoints */}
					<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
						{checks.map((ck) => {
							const done = local >= ck.cue;
							const pop = springAt(local, ck.cue, {
								damping: 16,
								stiffness: 230,
								mass: 0.9,
							});
							return (
								<div
									key={ck.label}
									style={{
										display: "flex",
										alignItems: "center",
										justifyContent: "space-between",
										padding: "11px 14px",
										borderRadius: 10,
										backgroundColor: done ? palette.citeBg : palette.bg,
										border: `1px solid ${done ? palette.citeBorder : palette.borderSubtle}`,
									}}
								>
									<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
										<span
											style={{
												display: "inline-flex",
												alignItems: "center",
												justifyContent: "center",
												width: 22,
												height: 22,
												borderRadius: 99,
												backgroundColor: done ? palette.cite : palette.mutedBg,
												color: done ? palette.citeSolidFg : palette.dimFg,
												fontSize: 12,
												fontWeight: 700,
												transform: `scale(${done ? mix(0.75, 1, pop).toFixed(3) : 1})`,
											}}
										>
											{done ? "✓" : "·"}
										</span>
										<span
											style={{
												fontSize: 14,
												fontWeight: 600,
												color: palette.fg,
											}}
										>
											{ck.label}
										</span>
									</div>
									<span
										style={{
											fontFamily: FONT_MONO,
											fontSize: 12,
											color: palette.mutedFg,
										}}
									>
										{ck.detail}
									</span>
								</div>
							);
						})}
					</div>
				</div>
			</div>
		</div>
	);
};

/**
 * Chapter 3 (8-12s, 240..360f): chip-grid-single-select-blackout — Pre-Retrieval ACL Isolation.
 * Bilingual (zh-CN / en) + Light & Dark faithful port of our signature Shot 3 grammar!
 */
const SceneAclBlackout: React.FC<{
	locale: FilmProps["locale"];
	palette: FilmPalette;
	frame: number;
}> = ({ locale, palette, frame }) => {
	const local = Math.max(0, frame - CH2_END); // 0..120f

	const chips = [
		{
			label: pickText(locale, "公司制度与流程", "Internal Policies"),
			meta: pickText(locale, "5 份 · 已授权", "5 docs · Authorized"),
			allowed: true,
			row: 0,
			col: 0,
		},
		{
			label: pickText(locale, "高管薪酬表", "Exec Payroll"),
			meta: pickText(locale, "受限", "Restricted"),
			allowed: false,
			row: 0,
			col: 1,
		},
		{
			label: pickText(locale, "并购草案", "M&A Drafts"),
			meta: pickText(locale, "受限", "Restricted"),
			allowed: false,
			row: 0,
			col: 2,
		},
		{
			label: pickText(locale, "法务密级档案", "Legal Sealed"),
			meta: pickText(locale, "受限", "Restricted"),
			allowed: false,
			row: 1,
			col: 0,
		},
		{
			label: pickText(locale, "财务审计底稿", "Finance Raw"),
			meta: pickText(locale, "受限", "Restricted"),
			allowed: false,
			row: 1,
			col: 1,
		},
	];

	// Key moments inside Chapter 3 (0..120f):
	// f0..24: cursor arcs in to chip 0
	// f26: cursor clicks chip 0 (tactile press + 1f neutral flash)
	// f28..33: 5-frame HARD linear blackout drops unselected 4 chips to 18% (transform: none!)
	// f58..76: collapse unselected -> selected chip glides to center top
	// f76..92: struck "4 restricted scopes" -> bold "0 leaks" + green ACL pill!
	const FS = 26;
	const F_COLLAPSE = 58;
	const F_RES = 76;

	const chipW = 356;
	const chipH = 74;
	const gapX = 24;
	const gapY = 24;
	const row0StartX = (1440 - (chipW * 3 + gapX * 2)) / 2;
	const row1StartX = (1440 - (chipW * 2 + gapX)) / 2;
	const row0Y = 290;
	const row1Y = row0Y + chipH + gapY;

	const posOf = (row: number, col: number) => ({
		x: (row === 0 ? row0StartX : row1StartX) + col * (chipW + gapX),
		y: row === 0 ? row0Y : row1Y,
	});

	const c0 = posOf(0, 0);
	const targetCx = (1440 - chipW) / 2;
	const targetCy = 186;

	// Pointer cursor trajectory
	const curT = ramp(local, 4, 20, EASE.snappy);
	const curX = mix(1180, c0.x + chipW * 0.62, curT);
	const curY = mix(560, c0.y + chipH * 0.62, curT);
	const curOp =
		ramp(local, 2, 6, EASE.out) * (1 - ramp(local, 46, 8, EASE.out));
	const press =
		ramp(local, FS - 2, 3, EASE.out) * (1 - ramp(local, FS + 1, 5, EASE.out));

	// Hard 5-frame blackout on unselected chips
	const blackP = interpolate(local, [FS + 2, FS + 7], [0, 1], clamp);
	const collapseP = ramp(local, F_COLLAPSE, 18, EASE.swift);
	const otherFade = 1 - ramp(local, F_COLLAPSE, 10, EASE.out);
	const headFade = 1 - ramp(local, F_COLLAPSE - 2, 10, EASE.out);

	const resP = ramp(local, F_RES, 12, EASE.snappy);
	const strikeP = ramp(local, F_RES + 4, 10, EASE.snappy);
	const pillP = springAt(local, F_RES + 10, {
		damping: 16,
		stiffness: 220,
		mass: 0.9,
	});
	// Localized click confirmation ring purely around chip 0 (ZERO full-screen flash!)
	const ringP = ramp(local, FS, 11, EASE.out);
	const ringOp =
		local >= FS && local < FS + 12 ? (1 - ringP) * 0.55 : 0;

	return (
		<div style={{ position: "relative", width: 1440, height: 756 }}>
			{/* Header prompt (fades out cleanly on collapse) */}
			{headFade > 0.01 && (
				<div
					style={{
						position: "absolute",
						top: 96,
						left: 0,
						right: 0,
						textAlign: "center",
						opacity: headFade,
						transform: `translateY(${((1 - headFade) * -12).toFixed(1)}px)`,
					}}
				>
					<div
						style={{
							fontFamily: FONT_MONO,
							fontSize: 13,
							fontWeight: 700,
							letterSpacing: "0.1em",
							textTransform: "uppercase",
							color: palette.cite,
							marginBottom: 12,
						}}
					>
						{pickText(locale, "服务端权限过滤 · 检索前执行", "SERVER-ENFORCED PRE-RETRIEVAL ACL")}
					</div>
					<div
						style={{
							fontSize: 34,
							fontWeight: 650,
							letterSpacing: "-0.025em",
							color: palette.fg,
						}}
					>
						{pickText(
							locale,
							"仅当前成员有权访问的范围进入向量与关键词召回",
							"Only authorized scopes enter vector and keyword recall",
						)}
					</div>
				</div>
			)}

			{/* 5 Scope Chips */}
			{chips.map((ch, idx) => {
				const base = posOf(ch.row, ch.col);
				const isSel = ch.allowed;
				const x = isSel ? mix(base.x, targetCx, collapseP) : base.x;
				const y = isSel ? mix(base.y, targetCy, collapseP) : base.y;
				const isActive = isSel && local >= FS;

				const op = isSel
					? 1
					: mix(1, 0.18, blackP) * otherFade;

				if (op <= 0.005) return null;

				const sc = isSel
					? 1 - 0.045 * press + 0.04 * collapseP
					: 1; // Unselected chips STRICTLY keep scale=1 (transform: none during blackout!)

				return (
					<div
						key={idx}
						style={{
							position: "absolute",
							left: x,
							top: y,
							width: chipW,
							height: chipH,
							borderRadius: 999,
							padding: "0 24px",
							boxSizing: "border-box",
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							backgroundColor: isActive ? palette.primary : palette.card,
							color: isActive ? palette.primaryFg : palette.fg,
							border: `1.5px solid ${isActive ? palette.primary : palette.border}`,
							boxShadow: isActive ? palette.shadow : palette.shadowSm,
							opacity: op,
							transform: isSel ? `scale(${sc.toFixed(4)})` : "none",
						}}
					>
						<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
							<span
								style={{
									color: isActive ? palette.cite : palette.dimFg,
									fontWeight: 800,
									fontSize: 16,
								}}
							>
								{isActive ? "✓" : isSel ? "○" : "×"}
							</span>
							<span
								style={{
									fontSize: 18,
									fontWeight: 650,
									letterSpacing: "-0.01em",
								}}
							>
								{ch.label}
							</span>
						</div>
						<span
							style={{
								fontFamily: FONT_MONO,
								fontSize: 12,
								fontWeight: 600,
								color: isActive
									? alpha(palette.primaryFg, 0.86)
									: palette.mutedFg,
							}}
						>
							{ch.meta}
						</span>
					</div>
				);
			})}

			{/* Localized tactile emerald click ring around selected chip only (zero screen flicker!) */}
			{ringOp > 0.01 && (
				<div
					style={{
						position: "absolute",
						left: c0.x,
						top: c0.y,
						width: chipW,
						height: chipH,
						borderRadius: 999,
						border: `2px solid ${palette.cite}`,
						opacity: ringOp,
						transform: `scale(${(1 + 0.065 * ringP).toFixed(4)})`,
						pointerEvents: "none",
					}}
				/>
			)}

			{/* Result Hero Lockup: Struck Restricted Scopes -> 0 Leaks + Green Verified Pill */}
			{resP > 0.01 && (
				<div
					style={{
						position: "absolute",
						left: 0,
						right: 0,
						top: 320,
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						gap: 28,
						opacity: resP,
						transform: `translateY(${((1 - resP) * 18).toFixed(1)}px)`,
					}}
				>
					<div
						style={{
							display: "flex",
							alignItems: "baseline",
							justifyContent: "center",
							gap: 36,
						}}
					>
						<span
							style={{
								position: "relative",
								fontSize: 34,
								fontWeight: 550,
								color: palette.dimFg,
								letterSpacing: "-0.02em",
							}}
						>
							{pickText(locale, "4 个受限范围", "4 restricted scopes")}
							<span
								style={{
									position: "absolute",
									left: -6,
									right: -6,
									top: "52%",
									height: 3,
									backgroundColor: palette.dimFg,
									transformOrigin: "left center",
									transform: `scaleX(${strikeP.toFixed(4)})`,
								}}
							/>
						</span>

						<div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
							<span
								style={{
									fontSize: 96,
									fontWeight: 750,
									lineHeight: 0.95,
									letterSpacing: "-0.04em",
									color: palette.fg,
									fontVariantNumeric: "tabular-nums",
								}}
							>
								0
							</span>
							<span
								style={{
									fontSize: 36,
									fontWeight: 650,
									color: palette.cite,
									letterSpacing: "-0.02em",
								}}
							>
								{pickText(locale, "越权召回", "leaks")}
							</span>
						</div>
					</div>

					<div
						style={{
							padding: "13px 30px",
							borderRadius: 999,
							backgroundColor: palette.cite,
							color: palette.citeSolidFg,
							fontSize: 20,
							fontWeight: 650,
							letterSpacing: "-0.01em",
							boxShadow: palette.shadow,
							opacity: Math.min(1, pillP * 1.4),
							transform: `scale(${mix(0.88, 1, pillP).toFixed(4)})`,
						}}
					>
						{pickText(
							locale,
							"ACL 在向量与关键词检索前强制生效，绝不依赖提示词保密",
							"ACL enforced before vector & keyword recall — never left to prompts",
						)}
					</div>
				</div>
			)}

			{/* Crisp Pointer Cursor */}
			{curOp > 0.01 && (
				<svg
					width={34}
					height={38}
					viewBox="0 0 28 32"
					style={{
						position: "absolute",
						left: curX,
						top: curY,
						opacity: curOp,
						transform: `scale(${(1 - 0.14 * press).toFixed(3)})`,
						filter: "drop-shadow(0 6px 12px rgba(0,0,0,0.28))",
						pointerEvents: "none",
					}}
				>
					<path
						d="M3 2 L3 25 L9.5 19.2 L14.5 29 L18.5 27 L13.4 17.4 L22.5 17.4 Z"
						fill={palette.primary}
						stroke={palette.primaryFg}
						strokeWidth={2}
						strokeLinejoin="round"
					/>
				</svg>
			)}
		</div>
	);
};

export const UnoRAGHeroFilm: React.FC<FilmProps> = ({ locale, theme }) => {
	const frame = useCurrentFrame();
	const { fps } = useVideoConfig();
	const palette = getPalette(theme);

	const chapterIdx: 0 | 1 | 2 =
		frame < CH1_END ? 0 : frame < CH2_END ? 1 : 2;

	// Crisp 8-frame Swiss opacity/lift transition between chapters (exact alignment to 0s / 4s / 8s)
	const ch1Op =
		frame < CH1_END
			? 1 - ramp(frame, CH1_END - 7, 7, EASE.out)
			: 0;
	const ch2Op =
		frame >= CH1_END - 4 && frame < CH2_END
			? ramp(frame, CH1_END - 4, 7, EASE.out) *
				(1 - ramp(frame, CH2_END - 7, 7, EASE.out))
			: 0;
	const ch3Op =
		frame >= CH2_END - 4
			? ramp(frame, CH2_END - 4, 7, EASE.out) *
				(1 - ramp(frame, 12 * fps - 6, 6, EASE.out))
			: 0;

	return (
		<AbsoluteFill
			style={{
				backgroundColor: palette.bg,
				fontFamily: FONT_SANS,
				color: palette.fg,
				overflow: "hidden",
			}}
		>
			<FilmFonts />
			<SwissStage theme={theme} palette={palette} gridSize={48} />

			<TopWorkspaceBar
				locale={locale}
				theme={theme}
				palette={palette}
				chapterIdx={chapterIdx}
				frame={frame}
			/>

			<div style={{ position: "relative", flex: 1 }}>
				{ch1Op > 0.005 && (
					<div style={{ position: "absolute", inset: 0, opacity: ch1Op }}>
						<SceneCitationScan
							locale={locale}
							palette={palette}
							frame={frame}
						/>
					</div>
				)}
				{ch2Op > 0.005 && (
					<div style={{ position: "absolute", inset: 0, opacity: ch2Op }}>
						<SceneRetrievalJudge
							locale={locale}
							palette={palette}
							frame={frame}
						/>
					</div>
				)}
				{ch3Op > 0.005 && (
					<div style={{ position: "absolute", inset: 0, opacity: ch3Op }}>
						<SceneAclBlackout
							locale={locale}
							palette={palette}
							frame={frame}
						/>
					</div>
				)}
			</div>

			<FilmGrain opacity={theme === "dark" ? 0.04 : 0.022} />
		</AbsoluteFill>
	);
};
