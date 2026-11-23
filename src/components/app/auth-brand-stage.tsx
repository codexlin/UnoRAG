"use client";

import { Check, FileText } from "lucide-react";
import { useInterfaceText } from "@/lib/i18n/provider";

export function AuthBrandStage() {
	const t = useInterfaceText();

	return (
		<aside
			aria-label={t("产品概览", "Product overview")}
			className="relative hidden overflow-hidden border-r border-border bg-sidebar text-sidebar-foreground lg:flex lg:flex-col lg:justify-between lg:px-10 lg:py-12 xl:px-14 xl:py-14"
		>
			<div
				aria-hidden
				className="pointer-events-none absolute inset-0 opacity-60 [background-image:linear-gradient(to_right,color-mix(in_oklch,var(--border)_55%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_oklch,var(--border)_55%,transparent)_1px,transparent_1px)] [background-size:48px_48px] [mask-image:radial-gradient(ellipse_78%_72%_at_50%_46%,#000_35%,transparent_100%)]"
			/>

			<div className="relative mx-auto flex w-full max-w-lg flex-1 flex-col justify-between gap-10">
				<div className="my-auto space-y-7">
					<div className="space-y-3">
						<h2 className="text-2xl font-semibold leading-[1.3] tracking-[-0.02em] text-sidebar-foreground text-balance xl:text-[28px]">
							{t(
								"从内部文档到可核对的答案",
								"From internal documents to verifiable answers",
							)}
						</h2>
						<p className="max-w-[46ch] text-sm leading-6 text-muted-foreground">
							{t(
								"将文档治理、权限过滤检索与原文引用放进同一个自托管知识工作台。",
								"Document governance, permission-filtered retrieval, and inline source citations in one self-hosted workbench.",
							)}
						</p>
					</div>

					<figure className="overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm">
						<div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-5 py-3">
							<span className="inline-flex items-center gap-2 text-xs font-medium text-muted-foreground">
								<FileText className="size-3.5 shrink-0" aria-hidden />
								{t("示例 · 员工手册", "Example · Employee handbook")}
							</span>
							<span className="font-mono text-xs tabular-nums text-muted-foreground">
								v3 · §3.2
							</span>
						</div>

						<div className="space-y-4 px-5 py-5">
							<div className="space-y-1.5">
								<span className="block text-xs text-muted-foreground">
									{t("提问", "Question")}
								</span>
								<p className="text-sm font-medium leading-6 text-card-foreground">
									{t(
										"病假材料要在何时补交？",
										"When should I submit the remaining sick leave documents?",
									)}
								</p>
							</div>

							<div className="space-y-1.5 border-t border-border/80 pt-4">
								<span className="block text-xs text-muted-foreground">
									{t("有依据的回答", "Grounded answer")}
								</span>
								<p className="text-sm leading-6 text-card-foreground">
									{t(
										"返岗后三个工作日内，需在考勤系统补交二级及以上医院出具的诊断证明。",
										"Upload a medical certificate from an accredited hospital to the attendance system within three business days of returning.",
									)}{" "}
									<span className="inline-flex items-center rounded-sm border border-evidence/30 bg-evidence/12 px-1.5 py-0.5 align-baseline font-mono text-xs font-medium leading-none text-evidence">
										[1]
									</span>
								</p>
							</div>
						</div>

						<figcaption className="border-t border-border bg-background/70 px-5 py-3.5">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<span className="inline-flex min-w-0 items-center gap-2">
									<span className="inline-flex items-center rounded-sm border border-evidence/30 bg-evidence/12 px-1.5 py-0.5 font-mono text-xs font-medium leading-none text-evidence">
										1
									</span>
									<span className="truncate font-mono text-xs text-foreground">
										employee-handbook-v3.md
									</span>
								</span>
								<span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-cite">
									<Check className="size-3.5" aria-hidden />
									{t("已校验原文", "Verified excerpt")}
								</span>
							</div>
							<p className="mt-2 text-xs leading-5 text-muted-foreground">
								{t(
									"“员工因病连续休假超过两日的，应于返岗后三个工作日内在考勤系统补交二级及以上医院出具的诊断证明。”",
									'"Employees on sick leave for more than two consecutive days must submit a hospital medical certificate within three business days of returning."',
								)}
							</p>
						</figcaption>
					</figure>
				</div>

				<dl className="grid grid-cols-3 gap-5 border-t border-border pt-5">
					<div className="space-y-1">
						<dt className="text-xs font-medium text-sidebar-foreground">
							{t("权限先于检索", "Permission-first")}
						</dt>
						<dd className="text-xs leading-5 text-muted-foreground">
							{t("按工作区与文档 ACL 过滤", "Filtered by workspace & ACL")}
						</dd>
					</div>
					<div className="space-y-1">
						<dt className="text-xs font-medium text-sidebar-foreground">
							{t("版本安全切换", "Verified cutover")}
						</dt>
						<dd className="text-xs leading-5 text-muted-foreground">
							{t("校验通过后生效，失败保留旧版", "Goes live only after checks")}
						</dd>
					</div>
					<div className="space-y-1">
						<dt className="text-xs font-medium text-sidebar-foreground">
							{t("请求全链路可查", "Traceable runs")}
						</dt>
						<dd className="text-xs leading-5 text-muted-foreground">
							{t("保留召回、耗时与引用依据", "Retrieval, timing & citations")}
						</dd>
					</div>
				</dl>
			</div>
		</aside>
	);
}
