import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import {
	EASE,
	FilmFonts,
	FilmGrain,
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

// Shotcraft row-embed timings (all 5 rows seat cleanly before background generation cutover!)
const ROW_CUES = [2, 10, 18, 25, 32];
const ROW_FLY = 12;

export const UnoRAGLibraryFilm: React.FC<FilmProps> = ({ locale, theme }) => {
	const frame = useCurrentFrame();
	const palette = getPalette(theme);

	// Staged generation background pipeline runs f52..168, atomic cutover snaps at f174!
	const stageProgress = ramp(frame, 52, 114, EASE.swift);
	const cutoverFrame = 174;
	const cutoverDone = frame >= cutoverFrame;
	const cutoverSpring = springAt(frame, cutoverFrame, {
		damping: 16,
		stiffness: 220,
		mass: 0.9,
	});
	const cutoverSweep = ramp(frame, cutoverFrame, 18, EASE.snappy);

	const steps = [
		pickText(locale, "传输", "Transfer"),
		pickText(locale, "解析", "Parse"),
		pickText(locale, "切分", "Chunk"),
		pickText(locale, "向量化", "Embed"),
		pickText(locale, "校验切换", "Verify"),
	];
	const activeStepIdx = cutoverDone
		? 5
		: Math.min(4, Math.floor(stageProgress * 5));

	// Dual-state separation per docs/DESIGN.md: Availability vs Latest Job!
	const rows = [
		{
			name: pickText(locale, "员工手册", "Employee Handbook"),
			file: "employee-handbook.md",
			availability: pickText(locale, "可问答", "Searchable"),
			availTone: "cite" as const,
			job: cutoverDone
				? pickText(locale, "已完成 · 新版生效", "Completed · Cutover")
				: pickText(locale, "后台校验中（旧版在线）", "Staging (prev active)"),
			jobTone: cutoverDone ? ("cite" as const) : ("evidence" as const),
			chunks: cutoverDone ? "48" : "42",
			updated: cutoverDone
				? pickText(locale, "刚刚切换", "Just switched")
				: "2026-11-22 16:42",
			isPrimary: true,
		},
		{
			name: pickText(locale, "财务报销制度", "Expense Reimbursement"),
			file: "expense-reimbursement.pdf",
			availability: pickText(locale, "可问答", "Searchable"),
			availTone: "cite" as const,
			job: pickText(locale, "已完成", "Completed"),
			jobTone: "muted" as const,
			chunks: "29",
			updated: "2026-11-21 09:15",
			isPrimary: false,
		},
		{
			name: pickText(locale, "信息安全与访问基线", "Security & Access Baseline"),
			file: "security-baseline.pdf",
			availability: pickText(locale, "可问答", "Searchable"),
			availTone: "cite" as const,
			job: pickText(locale, "已完成", "Completed"),
			jobTone: "muted" as const,
			chunks: "37",
			updated: "2026-11-19 14:08",
			isPrimary: false,
		},
		{
			name: pickText(locale, "差旅管理办法", "Travel Guidelines"),
			file: "travel-guidelines.md",
			availability: pickText(locale, "可问答", "Searchable"),
			availTone: "cite" as const,
			job: pickText(locale, "已完成", "Completed"),
			jobTone: "muted" as const,
			chunks: "19",
			updated: "2026-11-16 11:30",
			isPrimary: false,
		},
		{
			name: pickText(locale, "入职设备清单", "Onboarding Hardware"),
			file: "onboarding-hardware.docx",
			availability: pickText(locale, "旧版仍可问答", "Previous active"),
			availTone: "cite" as const,
			job: pickText(locale, "新版解析失败", "Update failed"),
			jobTone: "warning" as const,
			chunks: "14",
			updated: "2026-11-12 18:04",
			isPrimary: false,
		},
	];

	const bannerP = ramp(frame, 44, 12, EASE.snappy);

	return (
		<AbsoluteFill
			style={{
				backgroundColor: palette.bg,
				fontFamily: FONT_SANS,
				color: palette.fg,
				display: "flex",
				flexDirection: "row",
				overflow: "hidden",
			}}
		>
			<FilmFonts />
			<SwissStage theme={theme} palette={palette} gridSize={48} />

			{/* Left Library Sidebar */}
			<div
				style={{
					position: "relative",
					zIndex: 2,
					width: 286,
					borderRight: `1px solid ${palette.border}`,
					backgroundColor: palette.sidebar,
					padding: "24px 18px",
					display: "flex",
					flexDirection: "column",
					gap: 16,
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 10,
						padding: "0 6px",
					}}
				>
					<UnoMarkImg theme={theme} size={22} />
					<span
						style={{
							fontSize: 16,
							fontWeight: 650,
							letterSpacing: "-0.02em",
						}}
					>
						UnoRAG
					</span>
				</div>
				<div
					style={{
						fontSize: 12,
						fontWeight: 650,
						color: palette.mutedFg,
						padding: "8px 8px 0",
						letterSpacing: "0.02em",
					}}
				>
					{pickText(locale, "知识库（3）", "Libraries (3)")}
				</div>
				{[
					{
						name: pickText(locale, "公司制度与流程", "Company Policies"),
						sub: pickText(locale, "5 份可问答 · 已就绪", "5 searchable · Ready"),
						active: true,
					},
					{
						name: pickText(locale, "研发架构文档", "Engineering Docs"),
						sub: pickText(locale, "18 份可问答 · 已就绪", "18 searchable · Ready"),
						active: false,
					},
					{
						name: pickText(locale, "运维与故障预案", "Operations Runbooks"),
						sub: pickText(locale, "9 份可问答 · 已就绪", "9 searchable · Ready"),
						active: false,
					},
				].map((lib) => (
					<div
						key={lib.name}
						style={{
							padding: "13px 14px",
							borderRadius: 11,
							backgroundColor: lib.active ? palette.card : "transparent",
							border: `1px solid ${lib.active ? palette.border : "transparent"}`,
							boxShadow: lib.active ? palette.shadowSm : "none",
							display: "flex",
							flexDirection: "column",
							gap: 4,
						}}
					>
						<span style={{ fontSize: 14.5, fontWeight: 650, color: palette.fg }}>
							{lib.name}
						</span>
						<span style={{ fontSize: 12.5, color: palette.mutedFg }}>
							{lib.sub}
						</span>
					</div>
				))}

				<div
					style={{
						marginTop: "auto",
						padding: "12px 14px",
						borderRadius: 10,
						border: `1px solid ${palette.border}`,
						backgroundColor: palette.card,
						fontSize: 12,
						lineHeight: 1.55,
						color: palette.mutedFg,
					}}
				>
					<div style={{ fontWeight: 650, color: palette.fg, marginBottom: 4 }}>
						{pickText(locale, "双状态独立表达", "Dual-state governance")}
					</div>
					{pickText(
						locale,
						"问答可用性与后台入库任务分列呈现，失败替换绝不中断旧版服务。",
						"Availability stays separate from latest job status so failed updates never drop live docs.",
					)}
				</div>
			</div>

			{/* Main Governed Ledger */}
			<div
				style={{
					position: "relative",
					zIndex: 2,
					flex: 1,
					padding: "28px 34px",
					display: "flex",
					flexDirection: "column",
					gap: 18,
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "flex-start",
						justifyContent: "space-between",
					}}
				>
					<div>
						<div
							style={{
								fontSize: 25,
								fontWeight: 650,
								letterSpacing: "-0.025em",
							}}
						>
							{pickText(locale, "公司制度与流程", "Company Policies")}
						</div>
						<div
							style={{ fontSize: 14, color: palette.mutedFg, marginTop: 4 }}
						>
							{pickText(
								locale,
								"结构化解析 · DBOS 持久化入库 · 原子切换生效版本",
								"Structured parsing · DBOS durable ingest · Atomic version cutover",
							)}
						</div>
					</div>
					<div
						style={{
							display: "inline-flex",
							alignItems: "center",
							gap: 8,
							padding: "9px 16px",
							borderRadius: 9,
							backgroundColor: palette.primary,
							color: palette.primaryFg,
							fontSize: 13.5,
							fontWeight: 650,
						}}
					>
						<span>+</span>
						<span>{pickText(locale, "上传文档", "Upload documents")}</span>
					</div>
				</div>

				{/* Staged Generation Cutover Strip (steps through real ingestion stages!) */}
				<div
					style={{
						backgroundColor: cutoverDone ? palette.citeBg : palette.card,
						border: `1.5px solid ${cutoverDone ? palette.citeBorder : palette.border}`,
						borderRadius: 13,
						padding: "16px 20px",
						boxShadow: palette.shadowSm,
						display: "flex",
						flexDirection: "column",
						gap: 12,
						opacity: mix(0.65, 1, bannerP),
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
								fontSize: 14.5,
								fontWeight: 650,
								color: cutoverDone ? palette.cite : palette.fg,
							}}
						>
							{cutoverDone
								? pickText(
										locale,
										"✓ 员工手册已原子切换生效（校验通过 · 问答 0 中断）",
										"✓ Employee Handbook promoted atomically (verified · zero downtime)",
									)
								: pickText(
										locale,
										"后台构建新版本：employee-handbook.md · 旧版持续提供问答",
										"Building staged generation: employee-handbook.md · Previous version stays live",
									)}
						</span>
						<span
							style={{
								fontFamily: FONT_MONO,
								fontSize: 12.5,
								fontWeight: 700,
								color: cutoverDone ? palette.cite : palette.evidence,
							}}
						>
							{cutoverDone ? "STAGING → ACTIVE" : "DBOS WORKFLOW"}
						</span>
					</div>

					{/* Honest 5-stage pipeline pills (no fake percentage bar!) */}
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "repeat(5, 1fr)",
							gap: 8,
						}}
					>
						{steps.map((label, idx) => {
							const done = idx < activeStepIdx;
							const current = !cutoverDone && idx === activeStepIdx;
							return (
								<div
									key={label}
									style={{
										padding: "7px 10px",
										borderRadius: 8,
										display: "flex",
										alignItems: "center",
										justifyContent: "center",
										gap: 6,
										fontSize: 12.5,
										fontWeight: 650,
										backgroundColor: done
											? palette.citeBg
											: current
												? palette.evidenceBg
												: palette.mutedBg,
										border: `1px solid ${done ? palette.citeBorder : current ? palette.evidenceBorder : palette.borderSubtle}`,
										color: done
											? palette.cite
											: current
												? palette.evidence
												: palette.dimFg,
									}}
								>
									<span>{done ? "✓" : current ? "●" : "○"}</span>
									<span>{label}</span>
								</div>
							);
						})}
					</div>
				</div>

				{/* Governed Document Ledger with Shotcraft row-embed 3D landing & emerald lock seam */}
				<div
					style={{
						flex: 1,
						backgroundColor: palette.card,
						border: `1px solid ${palette.border}`,
						borderRadius: 14,
						overflow: "hidden",
						boxShadow: palette.shadow,
						display: "flex",
						flexDirection: "column",
					}}
				>
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "2.1fr 1.15fr 1.35fr 0.55fr 1.05fr",
							padding: "14px 22px",
							borderBottom: `1px solid ${palette.border}`,
							backgroundColor: palette.mutedBg,
							fontSize: 12.5,
							fontWeight: 650,
							color: palette.mutedFg,
						}}
					>
						<span>{pickText(locale, "文档名称", "Document")}</span>
						<span>{pickText(locale, "问答可用性", "Availability")}</span>
						<span>{pickText(locale, "最近任务", "Latest job")}</span>
						<span>{pickText(locale, "片段", "Chunks")}</span>
						<span style={{ textAlign: "right" }}>
							{pickText(locale, "更新时间", "Updated")}
						</span>
					</div>

					<div style={{ position: "relative", flex: 1 }}>
						{rows.map((row, idx) => {
							const cue = ROW_CUES[idx];
							const land = cue + ROW_FLY;
							const air =
								1 -
								interpolate(frame, [cue, land], [0, 1], {
									...clamp,
									easing: EASE.drop,
								});
							const appeared = ramp(frame, cue, 4, EASE.out);
							const settle =
								frame >= land
									? interpolate(frame, [land, land + 5], [0.994, 1], {
											...clamp,
											easing: EASE.out,
										})
									: 1.022 - 0.028 * (1 - air);

							// Landing emerald seam pulse
							const seamSpread = ramp(frame, land, 6, EASE.out);
							const seamOp =
								frame >= land && frame < land + 12
									? interpolate(frame, [land, land + 3, land + 12], [1, 1, 0], clamp)
									: 0;

							const jobColor =
								row.jobTone === "cite"
									? palette.cite
									: row.jobTone === "evidence"
										? palette.evidence
										: row.jobTone === "warning"
											? palette.warning
											: palette.mutedFg;

							const jobBg =
								row.jobTone === "cite"
									? palette.citeBg
									: row.jobTone === "evidence"
										? palette.evidenceBg
										: row.jobTone === "warning"
											? palette.warningBg
											: palette.mutedBg;

							const jobBorder =
								row.jobTone === "cite"
									? palette.citeBorder
									: row.jobTone === "evidence"
										? palette.evidenceBorder
										: row.jobTone === "warning"
											? palette.warningBorder
											: palette.border;

							return (
								<div
									key={row.file}
									style={{
										position: "relative",
										height: 92,
										borderBottom: `1px solid ${palette.borderSubtle}`,
									}}
								>
									{/* Dashed empty slot visible right before row drops in */}
									{air > 0.05 && (
										<div
											style={{
												position: "absolute",
												inset: "10px 16px",
												borderRadius: 8,
												border: `1px dashed ${alpha(palette.fg, 0.16)}`,
												backgroundColor: alpha(palette.fg, 0.015),
												opacity: air,
											}}
										/>
									)}

									{/* 3D Flying / Seated Row */}
									<div
										style={{
											position: "absolute",
											inset: 0,
											display: "grid",
											gridTemplateColumns: "2.1fr 1.15fr 1.35fr 0.55fr 1.05fr",
											alignItems: "center",
											padding: "0 22px",
											opacity: appeared,
											backgroundColor:
												row.isPrimary && cutoverDone
													? palette.citeBg
													: palette.card,
											transform:
												air > 0.001 || frame < land + 5
													? `perspective(900px) translateY(${(-74 * air).toFixed(2)}px) rotateX(${(13 * air).toFixed(2)}deg) scale(${settle.toFixed(4)})`
													: "none",
											boxShadow:
												air > 0.01
													? `0 ${(24 * air).toFixed(1)}px ${(44 * air).toFixed(1)}px -10px rgba(9,9,11,${(0.2 * air).toFixed(3)})`
													: "none",
											zIndex: air > 0.01 ? 5 : 1,
										}}
									>
										{/* Atomic cutover emerald horizontal sweep across Row 1 */}
										{row.isPrimary && cutoverDone && cutoverSweep < 1 && (
											<div
												style={{
													position: "absolute",
													inset: 0,
													background: `linear-gradient(90deg, ${alpha(palette.cite, 0)} 0%, ${alpha(palette.cite, 0.22)} 50%, ${alpha(palette.cite, 0)} 100%)`,
													transform: `translateX(${mix(-100, 100, cutoverSweep).toFixed(1)}%)`,
													pointerEvents: "none",
												}}
											/>
										)}

										<div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
											<span
												style={{
													fontSize: 15,
													fontWeight: 650,
													color: palette.fg,
												}}
											>
												{row.name}
											</span>
											<span
												style={{
													fontFamily: FONT_MONO,
													fontSize: 12,
													color: palette.mutedFg,
												}}
											>
												{row.file}
											</span>
										</div>

										<span>
											<span
												style={{
													display: "inline-flex",
													alignItems: "center",
													gap: 6,
													padding: "4px 10px",
													borderRadius: 999,
													backgroundColor: palette.citeBg,
													border: `1px solid ${palette.citeBorder}`,
													color: palette.cite,
													fontSize: 12.5,
													fontWeight: 650,
												}}
											>
												<span>●</span>
												<span>{row.availability}</span>
											</span>
										</span>

										<span>
											<span
												style={{
													display: "inline-flex",
													alignItems: "center",
													padding: "4px 10px",
													borderRadius: 7,
													backgroundColor: jobBg,
													border: `1px solid ${jobBorder}`,
													color: jobColor,
													fontSize: 12.5,
													fontWeight: 600,
													transform:
														row.isPrimary && cutoverDone
															? `scale(${mix(1.08, 1, cutoverSpring).toFixed(4)})`
															: "none",
												}}
											>
												{row.job}
											</span>
										</span>

										<span
											style={{
												fontFamily: FONT_MONO,
												fontSize: 13.5,
												fontWeight: 600,
												color:
													row.isPrimary && cutoverDone
														? palette.cite
														: palette.mutedFg,
												fontVariantNumeric: "tabular-nums",
											}}
										>
											{row.chunks}
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

									{/* Emerald lock seam spreading on exact seat frame */}
									{seamOp > 0.01 && (
										<div
											style={{
												position: "absolute",
												bottom: 0,
												left: `${((1 - seamSpread) * 50).toFixed(2)}%`,
												width: `${(seamSpread * 100).toFixed(2)}%`,
												height: 2.5,
												background: `linear-gradient(90deg, ${alpha(palette.cite, 0)}, ${palette.cite} 25%, ${palette.cite} 75%, ${alpha(palette.cite, 0)})`,
												opacity: seamOp,
												zIndex: 8,
												pointerEvents: "none",
											}}
										/>
									)}
								</div>
							);
						})}
					</div>
				</div>
			</div>

			<FilmGrain opacity={theme === "dark" ? 0.04 : 0.022} />
		</AbsoluteFill>
	);
};
