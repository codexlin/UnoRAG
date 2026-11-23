"use client";

import {
	Activity,
	ArrowLeft,
	ArrowRight,
	Check,
	FileText,
	MessageSquare,
	Quote,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useState } from "react";
import { useInterfaceText } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

const views = [
	{ id: "answer", label: ["回答", "Answer"], icon: MessageSquare },
	{ id: "source", label: ["原文", "Source"], icon: FileText },
	{ id: "trace", label: ["链路", "Trace"], icon: Activity },
] as const;

export type EvidenceView = (typeof views)[number]["id"];

type EvidenceExplorerProps = {
	view?: EvidenceView;
	onViewChange?: (view: EvidenceView) => void;
	embedded?: boolean;
};

export function EvidenceExplorer({
	view: controlledView,
	onViewChange,
	embedded = false,
}: EvidenceExplorerProps) {
	const t = useInterfaceText();
	const [internalView, setInternalView] = useState<EvidenceView>("answer");
	const view = controlledView ?? internalView;
	const setView = (next: EvidenceView) => {
		setInternalView(next);
		onViewChange?.(next);
	};
	const reducedMotion = useReducedMotion();

	return (
		<section
			className={cn(
				embedded
					? "border-t border-border bg-card text-card-foreground"
					: "landing-evidence",
			)}
			aria-label={t("知识工作流示例", "Knowledge workflow example")}
		>
			<div className={cn(embedded ? "px-4 sm:px-6" : "landing-wrap")}>
				<div className="landing-evidence-toolbar flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border py-2">
					<p className="landing-evidence-label flex items-center gap-2 text-xs text-muted-foreground">
						<FileText className="size-3.5 shrink-0" aria-hidden />
						<span>
							{t(
								"示例资料：员工手册（只读交互演示）",
								"Sample document: Employee handbook (interactive preview)",
							)}
						</span>
					</p>
					<fieldset className="inline-flex min-w-0 items-center gap-1 rounded-lg bg-muted/60 p-1">
						<legend className="sr-only">{t("示例视图", "Example view")}</legend>
						{views.map(({ id, label, icon: Icon }) => (
							<button
								key={id}
								type="button"
								aria-pressed={view === id}
								onClick={() => setView(id)}
								className={cn(
									"inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-9 motion-reduce:transition-none",
									view === id
										? "bg-card text-foreground shadow-2xs ring-1 ring-border"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								<Icon className="size-3.5" aria-hidden />
								{t(label[0], label[1])}
							</button>
						))}
					</fieldset>
				</div>
				<div className="landing-evidence-body">
					<div className="landing-evidence-question">
						<span className="text-xs text-muted-foreground">
							{t("示例提问", "Example question")}
						</span>
						<p className="mt-2 text-base font-medium leading-7 [text-wrap:pretty] sm:text-lg">
							{t(
								"病假材料要在何时补交？",
								"When should I submit the remaining sick leave documents?",
							)}
						</p>
					</div>
					<div className="min-w-0" aria-live="polite" aria-atomic="true">
						<AnimatePresence mode="wait" initial={false}>
							<motion.div
								key={view}
								initial={{ opacity: 0, y: reducedMotion ? 0 : 6 }}
								animate={{ opacity: 1, y: 0 }}
								exit={{ opacity: 0 }}
								transition={{
									duration: reducedMotion ? 0 : 0.22,
									ease: [0.22, 1, 0.36, 1],
								}}
								className="min-w-0"
							>
								{view === "answer" ? (
									<div>
										<p className="landing-evidence-answer [text-wrap:pretty]">
											{t("返岗后", "Within ")}
											<strong className="font-semibold">
												{t("三个工作日内", "three business days")}
											</strong>
											{t("补交。", " of returning to work.")}
											<button
												type="button"
												onClick={() => setView("source")}
												aria-label={t(
													"查看引用 1：员工手册",
													"View source 1: Employee handbook",
												)}
												className="relative ml-2 inline-flex size-6 align-middle items-center justify-center rounded-sm border border-evidence/35 bg-evidence/10 font-mono text-xs font-medium text-evidence transition-colors duration-200 hover:bg-evidence/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring after:absolute after:-inset-2.5 after:content-[''] motion-reduce:transition-none"
											>
												1
											</button>
										</p>
										<p className="landing-evidence-meta mt-3 flex items-center gap-2 text-xs text-muted-foreground">
											<Check
												className="size-3.5 shrink-0 text-cite"
												aria-hidden
											/>
											<span>
												{t(
													"依据：员工手册 / 第 3 章 请假制度",
													"Source: Employee handbook / Chapter 3, Leave Policy",
												)}
											</span>
										</p>
									</div>
								) : view === "source" ? (
									<div>
										<div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
											<span className="inline-flex items-center gap-1.5">
												<Quote className="size-3.5" aria-hidden />
												{t(
													"员工手册 · 第 3 章",
													"Employee handbook, Chapter 3",
												)}
											</span>
											<button
												type="button"
												onClick={() => setView("answer")}
												aria-label={t("返回示例回答", "Back to sample answer")}
												className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors duration-200 hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring md:min-h-9 motion-reduce:transition-none"
											>
												<ArrowLeft className="size-3.5" aria-hidden />
												<span>{t("返回回答", "Back")}</span>
											</button>
										</div>
										<blockquote className="rounded-lg border border-border bg-muted/35 px-4 py-3 text-sm leading-7 [text-wrap:pretty]">
											{t(
												"病假须提供二级甲等以上医院出具的诊断证明，须于",
												"Sick leave requires a medical certificate from an accredited hospital. Submit all documents ",
											)}
											<mark className="rounded-xs bg-evidence/15 px-1 py-0.5 text-evidence">
												{t(
													"返岗后三个工作日内",
													"within three business days of returning to work",
												)}
											</mark>
											{t("补交完整材料。", ".")}
										</blockquote>
									</div>
								) : (
									<div>
										<p className="mb-3 text-xs text-muted-foreground">
											{t("示例处理路径", "Example processing path")}
										</p>
										<ol className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm sm:grid-cols-3 lg:grid-cols-6">
											{[
												t("权限核对", "Access check"),
												t("检索", "Retrieval"),
												t("证据判断", "Evidence check"),
												t("生成", "Generation"),
												t("引用校验", "Citation check"),
												t("记录链路", "Trace recording"),
											].map((label, i) => (
												<li
													key={label}
													className="flex items-center gap-1.5 text-foreground"
												>
													<span className="font-mono text-xs tabular-nums text-muted-foreground">
														{String(i + 1).padStart(2, "0")}
													</span>
													<span>{label}</span>
												</li>
											))}
										</ol>
									</div>
								)}
							</motion.div>
						</AnimatePresence>
					</div>
				</div>
				<div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 py-2">
					<span className="text-xs text-muted-foreground">
						{t(
							"点击上方引用标记或标签，核对回答、原文与处理步骤。",
							"Click the citation chip or tabs to inspect the answer, source, and path.",
						)}
					</span>
					<Link
						href="/app/ask"
						className="landing-link inline-flex min-h-11 items-center gap-1 text-xs font-medium text-foreground md:min-h-9"
					>
						{t("进入完整问答工作台", "Open the full Ask workspace")}
						<ArrowRight className="size-3.5" aria-hidden />
					</Link>
				</div>
			</div>
		</section>
	);
}
