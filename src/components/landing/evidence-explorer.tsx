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
import { cn } from "@/lib/utils";

const views = [
	{ id: "answer", label: "回答", icon: MessageSquare },
	{ id: "source", label: "原文", icon: FileText },
	{ id: "trace", label: "链路", icon: Activity },
] as const;
type View = (typeof views)[number]["id"];

export function EvidenceExplorer() {
	const [view, setView] = useState<View>("answer");
	const reducedMotion = useReducedMotion();
	return (
		<section className="landing-evidence" aria-label="知识工作流示例">
			<div className="landing-wrap">
				<div className="landing-evidence-toolbar flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border py-1">
					<p className="landing-evidence-label flex items-center gap-2 text-xs text-muted-foreground">
						<FileText className="size-3.5" aria-hidden />
						<span>示例资料 · 员工手册</span>
					</p>
					<fieldset className="flex min-w-0 items-center gap-1">
						<legend className="sr-only">示例视图</legend>
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
								{label}
							</button>
						))}
					</fieldset>
				</div>
				<div className="landing-evidence-body">
					<div className="landing-evidence-question">
						<span className="text-xs text-muted-foreground">一个实际问题</span>
						<p className="mt-2 text-lg font-medium leading-7">
							病假材料要在何时补交？
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
											返岗后
											<strong className="font-medium">三个工作日内</strong>
											补交。
											<button
												type="button"
												onClick={() => setView("source")}
												aria-label="查看引用 1：员工手册"
												className="ml-2 inline-flex size-11 align-middle items-center justify-center rounded-md border border-evidence/25 bg-evidence/5 font-mono text-sm text-evidence transition-colors hover:bg-evidence/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
											>
												1
											</button>
										</p>
										<p className="landing-evidence-meta mt-3 flex items-center gap-2 text-xs text-muted-foreground">
											<Check className="size-3.5 text-cite" aria-hidden />
											依据：员工手册 / 第 3 章 请假制度
										</p>
									</div>
								) : view === "source" ? (
									<div>
										<div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
											<span className="inline-flex items-center gap-1.5">
												<Quote className="size-3.5" aria-hidden />
												员工手册 · 第 3 章
											</span>
											<button
												type="button"
												onClick={() => setView("answer")}
												aria-label="返回示例回答"
												className="inline-flex size-11 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
											>
												<ArrowLeft className="size-4" aria-hidden />
											</button>
										</div>
										<blockquote className="border-l-2 border-evidence pl-4 text-sm leading-7">
											病假须提供二级甲等以上医院出具的诊断证明，须于
											<mark className="bg-evidence/10 px-0.5 text-evidence">
												返岗后三个工作日内
											</mark>
											补交完整材料。
										</blockquote>
									</div>
								) : (
									<div>
										<p className="mb-3 text-xs text-muted-foreground">
											示例处理路径
										</p>
										<ol className="grid grid-cols-3 gap-x-3 gap-y-3 text-sm sm:grid-cols-6">
											{[
												"权限核对",
												"检索",
												"证据判断",
												"生成",
												"引用校验",
												"记录链路",
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
					进入完整问答工作台
					<ArrowUpRight className="size-3.5" aria-hidden />
				</a>
			</div>
		</section>
	);
}
