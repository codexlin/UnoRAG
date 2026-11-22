"use client";

import {
	Activity,
	ArrowLeft,
	ArrowUpRight,
	Check,
	FileText,
	MessageSquare,
	Quote,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { useInterfaceText } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

const views = [
	{ id: "answer", label: ["回答", "Answer"], icon: MessageSquare },
	{ id: "source", label: ["原文", "Source"], icon: FileText },
	{ id: "trace", label: ["链路", "Trace"], icon: Activity },
] as const;
type View = (typeof views)[number]["id"];

export function EvidenceExplorer() {
	const t = useInterfaceText();
	const [view, setView] = useState<View>("answer");
	const reducedMotion = useReducedMotion();
	return (
		<section
			className="landing-evidence"
			aria-label={t("知识工作流示例", "Knowledge workflow example")}
		>
			<div className="landing-wrap">
				<div className="landing-evidence-toolbar flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border py-1">
					<p className="landing-evidence-label flex items-center gap-2 text-xs text-muted-foreground">
						<FileText className="size-3.5" aria-hidden />
						<span>
							{t("示例资料 · 员工手册", "Sample document · Employee handbook")}
						</span>
					</p>
					<fieldset className="flex min-w-0 items-center gap-1">
						<legend className="sr-only">{t("示例视图", "Example view")}</legend>
						{views.map(({ id, label, icon: Icon }) => (
							<button
								key={id}
								type="button"
								aria-pressed={view === id}
								onClick={() => setView(id)}
								className={cn(
									"inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md px-3 text-xs transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none",
									view === id
										? "bg-foreground text-background"
										: "text-muted-foreground hover:bg-muted hover:text-foreground",
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
							{t("一个实际问题", "Example question")}
						</span>
						<p className="mt-2 text-lg font-medium leading-7">
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
								initial={{ opacity: 0, y: reducedMotion ? 0 : 5 }}
								animate={{ opacity: 1, y: 0 }}
								exit={{ opacity: 0 }}
								transition={{ duration: reducedMotion ? 0 : 0.14 }}
								className="min-w-0"
							>
								{view === "answer" ? (
									<div>
										<p className="landing-evidence-answer">
											{t("返岗后", "Within")}
											<strong className="font-medium">
												{t("三个工作日内", "three business days")}
											</strong>
											{t("补交。", "of returning to work.")}
											<button
												type="button"
												onClick={() => setView("source")}
												aria-label={t(
													"查看引用 1：员工手册",
													"View source 1: Employee handbook",
												)}
												className="ml-2 inline-flex size-11 align-middle items-center justify-center rounded-md border border-evidence/25 bg-evidence/5 font-mono text-sm text-evidence transition-colors hover:bg-evidence/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
											>
												1
											</button>
										</p>
										<p className="landing-evidence-meta mt-3 flex items-center gap-2 text-xs text-muted-foreground">
											<Check className="size-3.5 text-cite" aria-hidden />
											{t(
												"依据：员工手册 / 第 3 章 请假制度",
												"Source: Employee handbook / Chapter 3, Leave Policy",
											)}
										</p>
									</div>
								) : view === "source" ? (
									<div>
										<div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
											<span className="inline-flex items-center gap-1.5">
												<Quote className="size-3.5" aria-hidden />
												{t(
													"员工手册 · 第 3 章",
													"Employee handbook · Chapter 3",
												)}
											</span>
											<button
												type="button"
												onClick={() => setView("answer")}
												aria-label={t("返回示例回答", "Back to sample answer")}
												className="inline-flex size-11 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
											>
												<ArrowLeft className="size-4" aria-hidden />
											</button>
										</div>
										<blockquote className="border-l-2 border-evidence pl-4 text-sm leading-7">
											{t(
												"病假须提供二级甲等以上医院出具的诊断证明，须于",
												"Sick leave requires a medical certificate from a Grade II Class A hospital or above. Submit all documents",
											)}
											<mark className="bg-evidence/10 px-0.5 text-evidence">
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
										<ol className="grid grid-cols-3 gap-x-3 gap-y-3 text-sm sm:grid-cols-6">
											{[
												t("权限核对", "Access check"),
												t("检索", "Retrieval"),
												t("证据判断", "Evidence check"),
												t("生成", "Generation"),
												t("引用校验", "Citation check"),
												t("记录链路", "Trace recording"),
											].map((label, i) => (
												<li key={label} className="flex items-center gap-1.5">
													<span className="font-mono text-xs text-muted-foreground">
														{String(i + 1).padStart(2, "0")}
													</span>
													{label}
												</li>
											))}
										</ol>
									</div>
								)}
							</motion.div>
						</AnimatePresence>
					</div>
				</div>
				<a
					href="/app/ask"
					className="landing-evidence-more landing-link inline-flex min-h-11 items-center gap-1.5 text-xs text-muted-foreground"
				>
					{t("进入完整问答工作台", "Open the full Ask workspace")}
					<ArrowUpRight className="size-3.5" aria-hidden />
				</a>
			</div>
		</section>
	);
}
