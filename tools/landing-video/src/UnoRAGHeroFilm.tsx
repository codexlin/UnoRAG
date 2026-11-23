import React from "react";
import {
	AbsoluteFill,
	Easing,
	Img,
	interpolate,
	spring,
	staticFile,
	useCurrentFrame,
	useVideoConfig,
} from "remotion";
import {
	type FilmPalette,
	type FilmProps,
	FONT_MONO,
	FONT_SANS,
	getPalette,
	pickText,
} from "./theme";

const EASE_OUT = Easing.bezier(0.22, 1, 0.36, 1);

const HeaderBar: React.FC<{
	locale: FilmProps["locale"];
	palette: FilmPalette;
	theme: FilmProps["theme"];
}> = ({ locale, palette, theme }) => {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				height: 54,
				padding: "0 28px",
				borderBottom: `1px solid ${palette.border}`,
				backgroundColor: palette.card,
			}}
		>
			<div style={{ display: "flex", alignItems: "center", gap: 12 }}>
				<Img
					src={staticFile("uno-mark.svg")}
					style={{
						width: 22,
						height: 22,
						filter: theme === "dark" ? "brightness(0) invert(1)" : "none",
					}}
				/>
				<span
					style={{
						fontSize: 15,
						fontWeight: 600,
						color: palette.fg,
						letterSpacing: "-0.01em",
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
					{pickText(locale, "工作区 / 内部制度库", "Workspace / Internal Policies")}
				</span>
			</div>

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
					fontWeight: 600,
					fontFamily: FONT_MONO,
				}}
			>
				<span>●</span>
				<span>
					{pickText(locale, "已授权范围 · v3 生效中", "Authorized scope · v3 live")}
				</span>
			</div>
		</div>
	);
};

/** Chapter 1 (0-4s): Opens immediately populated on UnoRAG's signature Cited Answer <-> Source Excerpt */
const SceneCitation: React.FC<{
	locale: FilmProps["locale"];
	palette: FilmPalette;
}> = ({ locale, palette }) => {
	const frame = useCurrentFrame();
	const { fps } = useVideoConfig();
	const local = Math.max(0, frame);

	const answerFull = pickText(
		locale,
		"根据《员工手册》第 3 章规定，病假诊断证明须于返岗后三个工作日内在考勤系统补交。",
		"According to Chapter 3 of the Employee Handbook, submit your hospital medical certificate within three business days of returning to work.",
	);
	// Start at 65% typed on frame 0 so frame 0 is NEVER blank!
	const minChars = Math.floor(answerFull.length * 0.68);
	const charCount = Math.floor(
		interpolate(local, [0, 26], [minChars, answerFull.length], {
			extrapolateLeft: "clamp",
			extrapolateRight: "clamp",
		}),
	);
	const visibleAnswer = answerFull.slice(0, charCount);
	const chipScale = spring({
		fps,
		frame: Math.max(0, local - 18),
		config: { damping: 200 },
		from: 0.88,
		to: 1,
	});
	const lineProgress = interpolate(local, [16, 46], [0.25, 1], {
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
		easing: EASE_OUT,
	});
	const highlightSweep = interpolate(local, [28, 56], [30, 100], {
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
		easing: EASE_OUT,
	});

	return (
		<div
			style={{
				position: "relative",
				display: "grid",
				gridTemplateColumns: "1.06fr 0.94fr",
				gap: 44,
				padding: "38px 48px",
				height: "100%",
				boxSizing: "border-box",
				alignItems: "center",
			}}
		>
			<div
				style={{
					backgroundColor: palette.card,
					border: `1px solid ${palette.border}`,
					borderRadius: 14,
					padding: 28,
					boxShadow: palette.shadow,
					display: "flex",
					flexDirection: "column",
					gap: 18,
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
					<span style={{ fontSize: 13, fontWeight: 600, color: palette.mutedFg }}>
						{pickText(locale, "Ask 有据回答", "Grounded Answer")}
					</span>
					<span
						style={{
							fontSize: 12,
							fontWeight: 600,
							color: palette.cite,
							backgroundColor: palette.citeBg,
							border: `1px solid ${palette.citeBorder}`,
							padding: "4px 10px",
							borderRadius: 999,
						}}
					>
						{pickText(locale, "✓ 已关联 1 处授权原文", "✓ 1 authorized citation")}
					</span>
				</div>

				<div style={{ fontSize: 15, fontWeight: 500, color: palette.mutedFg }}>
					{pickText(
						locale,
						"问：病假材料要在何时补交？",
						"Q: When should I submit the remaining sick leave documents?",
					)}
				</div>

				<div
					style={{
						fontSize: 22,
						lineHeight: 1.6,
						fontWeight: 500,
						color: palette.fg,
						minHeight: 112,
					}}
				>
					{visibleAnswer}
					{local >= 16 ? (
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
								scale: `${chipScale}`,
							}}
						>
							1
						</span>
					) : null}
				</div>

				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 10,
						paddingTop: 12,
						borderTop: `1px solid ${palette.borderSubtle}`,
						fontSize: 13,
						color: palette.mutedFg,
					}}
				>
					<span style={{ color: palette.cite, fontWeight: 700 }}>✓</span>
					<span>
						{pickText(
							locale,
							"引用已校验 · 仅基于当前成员有权访问的生效版本",
							"Citation verified against the active authorized version",
						)}
					</span>
				</div>
			</div>

			<svg
				width="80"
				height="40"
				viewBox="0 0 80 40"
				style={{
					position: "absolute",
					left: "51.5%",
					top: "50%",
					marginTop: -20,
					marginLeft: -24,
					pointerEvents: "none",
				}}
			>
				<line
					x1="4"
					y1="20"
					x2={4 + 68 * lineProgress}
					y2="20"
					stroke={palette.evidence}
					strokeWidth="2.5"
					strokeDasharray="6 4"
				/>
				<circle cx={4 + 68 * lineProgress} cy="20" r="4.5" fill={palette.evidence} />
			</svg>

			<div
				style={{
					backgroundColor: palette.card,
					border: `1.5px solid ${palette.evidenceBorder}`,
					borderRadius: 14,
					padding: 26,
					boxShadow: palette.shadow,
					display: "flex",
					flexDirection: "column",
					gap: 16,
				}}
			>
				<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
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
						<span style={{ fontFamily: FONT_MONO, fontSize: 14, fontWeight: 600, color: palette.fg }}>
							employee-handbook-v3.md
						</span>
					</div>
					<span style={{ fontFamily: FONT_MONO, fontSize: 12, color: palette.mutedFg }}>
						§3.2 · v3
					</span>
				</div>

				<div
					style={{
						borderRadius: 10,
						backgroundColor: palette.mutedBg,
						border: `1px solid ${palette.border}`,
						padding: "16px 18px",
						fontSize: 16,
						lineHeight: 1.7,
						color: palette.fg,
					}}
				>
					{pickText(
						locale,
						"“病假须提供二级甲等以上医院出具的诊断证明，须于",
						'"Sick leave requires a medical certificate from an accredited hospital. Submit all documents ',
					)}
					<span
						style={{
							backgroundImage: `linear-gradient(90deg, ${palette.evidenceBg} ${highlightSweep}%, transparent ${highlightSweep}%)`,
							color: palette.evidence,
							fontWeight: 600,
							padding: "2px 5px",
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

				<div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
					<span style={{ color: palette.cite, fontWeight: 600 }}>
						{pickText(locale, "✓ 已校验原文定位", "✓ Verified source span")}
					</span>
					<span style={{ fontFamily: FONT_MONO, color: palette.mutedFg }}>
						{pickText(locale, "耗时 1.84s", "Latency 1.84s")}
					</span>
				</div>
			</div>
		</div>
	);
};

/** Chapter 2 (4-8s): Hybrid Retrieval & Evidence Judge */
const SceneRetrieval: React.FC<{
	locale: FilmProps["locale"];
	palette: FilmPalette;
}> = ({ locale, palette }) => {
	const frame = useCurrentFrame();
	const { fps } = useVideoConfig();
	const local = Math.max(0, frame - 4 * fps);

	const highlightSweep = interpolate(local, [24, 62], [20, 100], {
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
		easing: EASE_OUT,
	});
	const judgeIn = spring({
		fps,
		frame: Math.max(0, local - 46),
		config: { damping: 200 },
	});

	const candidates = [
		{
			doc: pickText(
				locale,
				"员工手册-v3.md · §3.2 请假制度",
				"employee-handbook-v3.md · §3.2 Leave Policy",
			),
			score: 0.94,
			selected: true,
		},
		{
			doc: pickText(
				locale,
				"考勤与休假规范.pdf · 第 4 页",
				"leave-attendance-policy.pdf · Page 4",
			),
			score: 0.72,
			selected: false,
		},
		{
			doc: pickText(
				locale,
				"员工手册-v3.md · §3.5 考勤申诉",
				"employee-handbook-v3.md · §3.5 Attendance Appeal",
			),
			score: 0.56,
			selected: false,
		},
	];

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				justifyContent: "center",
				gap: 22,
				padding: "32px 48px",
				height: "100%",
				boxSizing: "border-box",
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					padding: "16px 22px",
					borderRadius: 12,
					border: `1px solid ${palette.border}`,
					backgroundColor: palette.card,
					boxShadow: palette.shadowSm,
				}}
			>
				<div style={{ display: "flex", alignItems: "center", gap: 14 }}>
					<span
						style={{
							fontSize: 12,
							fontWeight: 600,
							padding: "4px 10px",
							borderRadius: 6,
							backgroundColor: palette.mutedBg,
							color: palette.mutedFg,
						}}
					>
						{pickText(locale, "提问", "Query")}
					</span>
					<span style={{ fontSize: 19, fontWeight: 600, color: palette.fg }}>
						{pickText(
							locale,
							"病假材料要在何时补交？",
							"When should I submit the remaining sick leave documents?",
						)}
					</span>
				</div>
				<span style={{ fontFamily: FONT_MONO, fontSize: 12, color: palette.mutedFg }}>
					{pickText(locale, "混合检索 + Rerank", "Hybrid + Rerank")}
				</span>
			</div>

			<div
				style={{
					display: "grid",
					gridTemplateColumns: "0.92fr 1.08fr",
					gap: 24,
					alignItems: "stretch",
				}}
			>
				<div
					style={{
						backgroundColor: palette.card,
						border: `1px solid ${palette.border}`,
						borderRadius: 14,
						padding: 20,
						display: "flex",
						flexDirection: "column",
						gap: 14,
					}}
				>
					<span style={{ fontSize: 13, fontWeight: 600, color: palette.mutedFg }}>
						{pickText(locale, "召回与重排得分", "Retrieved & Reranked Candidates")}
					</span>
					{candidates.map((item, idx) => {
						const rowProg = interpolate(
							local,
							[idx * 6, 24 + idx * 6],
							[0.35, 1],
							{
								extrapolateLeft: "clamp",
								extrapolateRight: "clamp",
								easing: EASE_OUT,
							},
						);
						return (
							<div
								key={item.doc}
								style={{
									padding: "14px 16px",
									borderRadius: 10,
									border: `1px solid ${item.selected ? palette.evidenceBorder : palette.border}`,
									backgroundColor: item.selected ? palette.evidenceBg : palette.bg,
									display: "flex",
									flexDirection: "column",
									gap: 10,
								}}
							>
								<div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
									<span
										style={{
											fontFamily: FONT_MONO,
											fontSize: 13,
											fontWeight: item.selected ? 600 : 500,
											color: palette.fg,
										}}
									>
										{item.doc}
									</span>
									<span
										style={{
											fontFamily: FONT_MONO,
											fontSize: 13,
											fontWeight: 600,
											color: item.selected ? palette.evidence : palette.mutedFg,
										}}
									>
										{item.score.toFixed(2)}
									</span>
								</div>
								<div
									style={{
										height: 7,
										borderRadius: 999,
										backgroundColor: palette.mutedBg,
										overflow: "hidden",
									}}
								>
									<div
										style={{
											height: "100%",
											width: `${item.score * 100 * rowProg}%`,
											borderRadius: 999,
											backgroundColor: item.selected ? palette.evidence : palette.mutedFg,
										}}
									/>
								</div>
							</div>
						);
					})}
				</div>

				<div
					style={{
						backgroundColor: palette.card,
						border: `1px solid ${palette.border}`,
						borderRadius: 14,
						padding: 24,
						display: "flex",
						flexDirection: "column",
						justifyContent: "space-between",
						gap: 18,
						boxShadow: palette.shadowSm,
					}}
				>
					<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
						<span style={{ fontFamily: FONT_MONO, fontSize: 13, fontWeight: 600, color: palette.fg }}>
							{pickText(locale, "命中原文片段 #1", "Matched Source Excerpt #1")}
						</span>
						<span
							style={{
								fontSize: 12,
								fontWeight: 600,
								padding: "5px 12px",
								borderRadius: 999,
								backgroundColor: palette.citeBg,
								border: `1px solid ${palette.citeBorder}`,
								color: palette.cite,
								opacity: Math.max(0.35, judgeIn),
							}}
						>
							{pickText(locale, "✓ 证据充分 · 通过核验", "✓ Evidence Judge · Grounded")}
						</span>
					</div>

					<div
						style={{
							borderRadius: 10,
							border: `1px solid ${palette.border}`,
							backgroundColor: palette.mutedBg,
							padding: "16px 18px",
							fontSize: 17,
							lineHeight: 1.75,
							color: palette.fg,
						}}
					>
						{pickText(
							locale,
							"员工因病连续休假超过两日的，须提供二级甲等以上医院出具的诊断证明，并于 ",
							"Sick leave over two consecutive days requires a medical certificate from an accredited hospital. Submit all documents ",
						)}
						<span
							style={{
								padding: "2px 6px",
								borderRadius: 5,
								fontWeight: 600,
								color: palette.evidence,
								backgroundImage: `linear-gradient(90deg, ${palette.evidenceBg} ${highlightSweep}%, transparent ${highlightSweep}%)`,
							}}
						>
							{pickText(
								locale,
								"返岗后三个工作日内",
								"within three business days of returning to work",
							)}
						</span>
						{pickText(locale, " 在考勤系统补交完整材料。", " in the attendance portal.")}
					</div>

					<div
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							borderTop: `1px solid ${palette.borderSubtle}`,
							paddingTop: 14,
							fontSize: 13,
							color: palette.mutedFg,
						}}
					>
						<span style={{ fontFamily: FONT_MONO }}>
							employee-handbook-v3.md · §3.2
						</span>
						<span>{pickText(locale, "冲突检查：无冲突", "Conflict check: None")}</span>
					</div>
				</div>
			</div>
		</div>
	);
};

/** Chapter 3 (8-12s): Server-side Scope & ACL Filtering */
const SceneScope: React.FC<{
	locale: FilmProps["locale"];
	palette: FilmPalette;
}> = ({ locale, palette }) => {
	const frame = useCurrentFrame();
	const { fps } = useVideoConfig();
	const local = Math.max(0, frame - 8 * fps);

	const docs = [
		{
			name: pickText(locale, "员工手册-v3.md", "employee-handbook-v3.md"),
			meta: pickText(locale, "42 切片 · 全员可见", "42 chunks · All members"),
			version: "v3",
			allowed: true,
		},
		{
			name: pickText(locale, "考勤与休假规范.pdf", "leave-attendance-policy.pdf"),
			meta: pickText(locale, "21 切片 · 全员可见", "21 chunks · All members"),
			version: "v2",
			allowed: true,
		},
		{
			name: pickText(locale, "信息安全基线.pdf", "security-baseline.pdf"),
			meta: pickText(locale, "36 切片 · 研发与运维", "36 chunks · Engineering"),
			version: "v5",
			allowed: true,
		},
		{
			name: pickText(locale, "薪酬测算明细.docx", "exec-comp-schedule.docx"),
			meta: pickText(
				locale,
				"受限文档 · 检索前排除",
				"Restricted ACL · Filtered out",
			),
			version: "v1",
			allowed: false,
		},
	];

	const filterDim = interpolate(local, [18, 42], [1, 0.38], {
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
		easing: EASE_OUT,
	});

	return (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "1.12fr 0.88fr",
				gap: 28,
				padding: "36px 40px",
				height: "100%",
				boxSizing: "border-box",
				alignItems: "center",
			}}
		>
			<div
				style={{
					backgroundColor: palette.card,
					border: `1px solid ${palette.border}`,
					borderRadius: 14,
					boxShadow: palette.shadowSm,
					overflow: "hidden",
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						padding: "16px 22px",
						borderBottom: `1px solid ${palette.border}`,
						backgroundColor: palette.mutedBg,
					}}
				>
					<span style={{ fontSize: 14, fontWeight: 600, color: palette.fg }}>
						{pickText(locale, "受控知识库文档", "Governed Library Documents")}
					</span>
					<span style={{ fontSize: 12, fontFamily: FONT_MONO, color: palette.mutedFg }}>
						{pickText(locale, "仅检索生效版本", "Active generations only")}
					</span>
				</div>
				<div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
					{docs.map((doc) => (
						<div
							key={doc.name}
							style={{
								display: "flex",
								alignItems: "center",
								justifyContent: "space-between",
								padding: "14px 16px",
								borderRadius: 10,
								border: `1px solid ${!doc.allowed && local > 24 ? palette.borderSubtle : palette.border}`,
								backgroundColor: palette.bg,
								opacity: doc.allowed ? 1 : filterDim,
							}}
						>
							<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
								<span
									style={{
										fontSize: 15,
										fontWeight: 600,
										fontFamily: FONT_MONO,
										color: palette.fg,
										textDecoration: !doc.allowed && local > 26 ? "line-through" : "none",
									}}
								>
									{doc.name}
								</span>
								<span style={{ fontSize: 13, color: palette.mutedFg }}>{doc.meta}</span>
							</div>
							<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
								<span
									style={{
										fontFamily: FONT_MONO,
										fontSize: 12,
										padding: "4px 9px",
										borderRadius: 6,
										border: `1px solid ${palette.border}`,
										color: palette.mutedFg,
									}}
								>
									{doc.version}
								</span>
								<span
									style={{
										fontSize: 12,
										fontWeight: 600,
										padding: "4px 10px",
										borderRadius: 6,
										backgroundColor: doc.allowed ? palette.citeBg : palette.mutedBg,
										border: `1px solid ${doc.allowed ? palette.citeBorder : palette.border}`,
										color: doc.allowed ? palette.cite : palette.mutedFg,
									}}
								>
									{doc.allowed
										? pickText(locale, "有权访问", "Authorized")
										: pickText(locale, "已拦截", "Excluded")}
								</span>
							</div>
						</div>
					))}
				</div>
			</div>

			<div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
				<div
					style={{
						alignSelf: "flex-start",
						display: "inline-flex",
						alignItems: "center",
						gap: 8,
						padding: "7px 14px",
						borderRadius: 999,
						backgroundColor: palette.citeBg,
						border: `1px solid ${palette.citeBorder}`,
						color: palette.cite,
						fontSize: 13,
						fontWeight: 600,
					}}
				>
					<span>✓</span>
					<span>
						{pickText(
							locale,
							"服务端权限边界已锁定（3 / 4 份文档进入召回）",
							"Server ACL locked (3 of 4 documents in scope)",
						)}
					</span>
				</div>
				<h3
					style={{
						margin: 0,
						fontSize: 30,
						lineHeight: 1.25,
						fontWeight: 600,
						letterSpacing: "-0.025em",
						color: palette.fg,
					}}
				>
					{pickText(
						locale,
						"检索发生之前，先完成权限与版本过滤。",
						"Enforce access rules and active versions before retrieval runs.",
					)}
				</h3>
				<p style={{ margin: 0, fontSize: 16, lineHeight: 1.65, color: palette.mutedFg }}>
					{pickText(
						locale,
						"组织、工作区、成员角色与文档级 ACL 由服务端解析并下推至向量与关键词召回，无权文档不会进入模型上下文。",
						"Workspace, library, and document ACL filters are pushed down to vector and keyword retrieval so restricted files never reach the model.",
					)}
				</p>
			</div>
		</div>
	);
};

export const UnoRAGHeroFilm: React.FC<FilmProps> = ({ locale, theme }) => {
	const frame = useCurrentFrame();
	const { fps } = useVideoConfig();
	const palette = getPalette(theme);

	const sceneIndex = frame < 4 * fps ? 0 : frame < 8 * fps ? 1 : 2;
	const sceneStart = sceneIndex * 4 * fps;
	const sceneEnd = sceneStart + 4 * fps;
	// Never fade from 0 at frame 0 so the opening frame is crisp and full!
	const fadeIn =
		sceneIndex === 0
			? 1
			: interpolate(frame, [sceneStart, sceneStart + 8], [0, 1], {
					extrapolateLeft: "clamp",
					extrapolateRight: "clamp",
				});
	const fadeOut = interpolate(frame, [sceneEnd - 7, sceneEnd], [1, 0], {
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
	});

	return (
		<AbsoluteFill
			style={{
				backgroundColor: palette.bg,
				fontFamily: FONT_SANS,
				color: palette.fg,
				backgroundImage: `linear-gradient(to right, ${palette.gridLine} 1px, transparent 1px), linear-gradient(to bottom, ${palette.gridLine} 1px, transparent 1px)`,
				backgroundSize: "48px 48px",
				display: "flex",
				flexDirection: "column",
			}}
		>
			<HeaderBar locale={locale} palette={palette} theme={theme} />
			<div style={{ flex: 1, minHeight: 0, opacity: fadeIn * fadeOut }}>
				{sceneIndex === 0 ? (
					<SceneCitation locale={locale} palette={palette} />
				) : sceneIndex === 1 ? (
					<SceneRetrieval locale={locale} palette={palette} />
				) : (
					<SceneScope locale={locale} palette={palette} />
				)}
			</div>
		</AbsoluteFill>
	);
};
