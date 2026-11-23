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
	type FilmProps,
	FONT_MONO,
	FONT_SANS,
	getPalette,
	pickText,
} from "./theme";

const EASE_OUT = Easing.bezier(0.22, 1, 0.36, 1);

export const UnoRAGLibraryFilm: React.FC<FilmProps> = ({ locale, theme }) => {
	const frame = useCurrentFrame();
	const { fps } = useVideoConfig();
	const palette = getPalette(theme);

	const stageProgress = interpolate(frame, [24, 154], [0, 1], {
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
		easing: EASE_OUT,
	});
	const cutoverDone = frame >= 162;
	const cutoverSpring = spring({
		fps,
		frame: Math.max(0, frame - 162),
		config: { damping: 200 },
	});

	const stageLabel =
		stageProgress < 0.3
			? pickText(locale, "解析文档结构...", "Parsing structure...")
			: stageProgress < 0.62
				? pickText(locale, "按章节切分块...", "Chunking sections...")
				: stageProgress < 0.92
					? pickText(locale, "写入向量与校验...", "Embedding & validating...")
					: pickText(locale, "校验通过，切换生效", "Verified · Cutover ready");

	const rows = [
		{
			name: pickText(locale, "员工手册.pdf", "employee-handbook.pdf"),
			version: cutoverDone ? "v4" : "v3",
			status: cutoverDone
				? pickText(locale, "已生效", "Active")
				: pickText(locale, "v4 校验中", "Validating v4"),
			chunks: cutoverDone ? "48" : "42",
			size: cutoverDone ? "312 KB" : "284 KB",
			updated: cutoverDone
				? pickText(locale, "刚刚", "Just now")
				: "2026-11-22 16:42",
			isPrimary: true,
		},
		{
			name: pickText(locale, "财务报销制度.pdf", "expense-reimbursement.pdf"),
			version: "v2",
			status: pickText(locale, "已生效", "Active"),
			chunks: "29",
			size: "248 KB",
			updated: "2026-11-21 09:15",
			isPrimary: false,
		},
		{
			name: pickText(locale, "信息安全规范.pdf", "security-baseline.pdf"),
			version: "v5",
			status: pickText(locale, "已生效", "Active"),
			chunks: "37",
			size: "196 KB",
			updated: "2026-11-19 14:08",
			isPrimary: false,
		},
		{
			name: pickText(locale, "差旅管理办法.md", "travel-guidelines.md"),
			version: "v1",
			status: pickText(locale, "已生效", "Active"),
			chunks: "19",
			size: "34 KB",
			updated: "2026-11-16 11:30",
			isPrimary: false,
		},
		{
			name: pickText(locale, "入职设备清单.docx", "onboarding-hardware.docx"),
			version: "v2",
			status: pickText(locale, "解析失败（保留 v1）", "Failed (v1 active)"),
			chunks: "14",
			size: "118 KB",
			updated: "2026-11-12 18:04",
			isPrimary: false,
			failed: true,
		},
	];

	return (
		<AbsoluteFill
			style={{
				backgroundColor: palette.bg,
				fontFamily: FONT_SANS,
				color: palette.fg,
				display: "flex",
				flexDirection: "row",
			}}
		>
			{/* Left Library Sidebar */}
			<div
				style={{
					width: 290,
					borderRight: `1px solid ${palette.border}`,
					backgroundColor: palette.sidebar,
					padding: "24px 18px",
					display: "flex",
					flexDirection: "column",
					gap: 18,
				}}
			>
				<div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 6px" }}>
					<Img
						src={staticFile("uno-mark.svg")}
						style={{
							width: 22,
							height: 22,
							filter: theme === "dark" ? "brightness(0) invert(1)" : "none",
						}}
					/>
					<span style={{ fontSize: 16, fontWeight: 600 }}>UnoRAG</span>
				</div>
				<div
					style={{
						fontSize: 12,
						fontWeight: 600,
						color: palette.mutedFg,
						padding: "8px 8px 0",
					}}
				>
					{pickText(locale, "知识库列表（3）", "Libraries (3)")}
				</div>
				{[
					{
						name: pickText(locale, "公司制度与流程", "Company Policies"),
						sub: pickText(locale, "5 份文档 · 已就绪", "5 documents · Ready"),
						active: true,
					},
					{
						name: pickText(locale, "研发架构文档", "Engineering Docs"),
						sub: pickText(locale, "18 份文档 · 已就绪", "18 documents · Ready"),
						active: false,
					},
					{
						name: pickText(locale, "运维与故障预案", "Operations Runbooks"),
						sub: pickText(locale, "9 份文档 · 已就绪", "9 documents · Ready"),
						active: false,
					},
				].map((lib) => (
					<div
						key={lib.name}
						style={{
							padding: "12px 14px",
							borderRadius: 10,
							backgroundColor: lib.active ? palette.card : "transparent",
							border: `1px solid ${lib.active ? palette.border : "transparent"}`,
							boxShadow: lib.active ? palette.shadowSm : "none",
							display: "flex",
							flexDirection: "column",
							gap: 4,
						}}
					>
						<span style={{ fontSize: 14, fontWeight: 600, color: palette.fg }}>
							{lib.name}
						</span>
						<span style={{ fontSize: 12, color: palette.mutedFg }}>{lib.sub}</span>
					</div>
				))}
			</div>

			{/* Main Workbench Ledger */}
			<div
				style={{
					flex: 1,
					padding: "28px 36px",
					display: "flex",
					flexDirection: "column",
					gap: 20,
				}}
			>
				<div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
					<div>
						<div style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em" }}>
							{pickText(locale, "公司制度与流程", "Company Policies")}
						</div>
						<div style={{ fontSize: 14, color: palette.mutedFg, marginTop: 4 }}>
							{pickText(
								locale,
								"制度切分策略 · 本地优先解析 · 全员工作区权限",
								"Regulatory chunking · Local-first parsing · Workspace ACL",
							)}
						</div>
					</div>
					<div
						style={{
							padding: "8px 16px",
							borderRadius: 8,
							backgroundColor: palette.primary,
							color: palette.primaryFg,
							fontSize: 13,
							fontWeight: 600,
						}}
					>
						{pickText(locale, "上传新版本", "Upload document")}
					</div>
				</div>

				{/* Live Background Validation Banner */}
				<div
					style={{
						backgroundColor: cutoverDone ? palette.citeBg : palette.card,
						border: `1px solid ${cutoverDone ? palette.citeBorder : palette.border}`,
						borderRadius: 12,
						padding: "16px 20px",
						display: "flex",
						flexDirection: "column",
						gap: 10,
					}}
				>
					<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
						<span
							style={{
								fontSize: 14,
								fontWeight: 600,
								color: cutoverDone ? palette.cite : palette.fg,
							}}
						>
							{cutoverDone
								? pickText(
										locale,
										"✓ employee-handbook.pdf 已原子切换至 v4（校验通过，0 中断）",
										"✓ employee-handbook.pdf promoted to v4 (validated with zero downtime)",
									)
								: pickText(
										locale,
										"后台任务：employee-handbook.pdf (v4) · 旧版 v3 持续服务中",
										"Background job: employee-handbook.pdf (v4) · v3 remains live",
									)}
						</span>
						<span
							style={{
								fontFamily: FONT_MONO,
								fontSize: 13,
								fontWeight: 600,
								color: cutoverDone ? palette.cite : palette.evidence,
							}}
						>
							{cutoverDone ? "100%" : `${Math.round(stageProgress * 100)}% · ${stageLabel}`}
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
								width: `${Math.round((cutoverDone ? 1 : stageProgress) * 100)}%`,
								borderRadius: 999,
								backgroundColor: cutoverDone ? palette.cite : palette.evidence,
							}}
						/>
					</div>
				</div>

				{/* Governed LedgerTable */}
				<div
					style={{
						flex: 1,
						backgroundColor: palette.card,
						border: `1px solid ${palette.border}`,
						borderRadius: 12,
						overflow: "hidden",
						boxShadow: palette.shadowSm,
					}}
				>
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "2.2fr 0.7fr 1.2fr 0.7fr 0.8fr 1.2fr",
							padding: "13px 20px",
							borderBottom: `1px solid ${palette.border}`,
							backgroundColor: palette.mutedBg,
							fontSize: 12,
							fontWeight: 600,
							color: palette.mutedFg,
						}}
					>
						<span>{pickText(locale, "文档名称", "Document")}</span>
						<span>{pickText(locale, "版本", "Version")}</span>
						<span>{pickText(locale, "状态", "Status")}</span>
						<span>{pickText(locale, "片段", "Chunks")}</span>
						<span>{pickText(locale, "大小", "Size")}</span>
						<span style={{ textAlign: "right" }}>{pickText(locale, "更新时间", "Updated")}</span>
					</div>
					{rows.map((row) => (
						<div
							key={row.name}
							style={{
								display: "grid",
								gridTemplateColumns: "2.2fr 0.7fr 1.2fr 0.7fr 0.8fr 1.2fr",
								alignItems: "center",
								padding: "16px 20px",
								borderBottom: `1px solid ${palette.borderSubtle}`,
								fontSize: 14,
								backgroundColor:
									row.isPrimary && cutoverDone
										? palette.citeBg
										: "transparent",
							}}
						>
							<span style={{ fontWeight: 600, fontFamily: FONT_MONO, fontSize: 13.5 }}>
								{row.name}
							</span>
							<span>
								<span
									style={{
										display: "inline-block",
										fontFamily: FONT_MONO,
										fontSize: 12,
										fontWeight: 600,
										padding: "3px 8px",
										borderRadius: 6,
										border: `1px solid ${row.isPrimary && cutoverDone ? palette.citeBorder : palette.border}`,
										color: row.isPrimary && cutoverDone ? palette.cite : palette.fg,
										scale: row.isPrimary && cutoverDone ? `${interpolate(cutoverSpring, [0, 1], [1.12, 1])}` : "1",
									}}
								>
									{row.version}
								</span>
							</span>
							<span
								style={{
									fontSize: 13,
									fontWeight: 500,
									color: row.failed
										? palette.warning
										: row.isPrimary && !cutoverDone
											? palette.evidence
											: palette.cite,
								}}
							>
								{row.status}
							</span>
							<span style={{ fontFamily: FONT_MONO, fontSize: 13, color: palette.mutedFg }}>
								{row.chunks}
							</span>
							<span style={{ fontFamily: FONT_MONO, fontSize: 13, color: palette.mutedFg }}>
								{row.size}
							</span>
							<span
								style={{
									fontFamily: FONT_MONO,
									fontSize: 12.5,
									color: palette.mutedFg,
									textAlign: "right",
								}}
							>
								{row.updated}
							</span>
						</div>
					))}
				</div>
			</div>
		</AbsoluteFill>
	);
};
