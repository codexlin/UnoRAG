"use client";

import { ChevronRight, FileText, RotateCcw } from "lucide-react";
import { useRef, useState } from "react";

import { AuthButton } from "@/components/app/auth-button";
import {
	DocumentStatusBadge,
	ParserReportCard,
} from "@/components/app/document-status";
import type { DetailAction } from "@/components/app/library-doc-actions";
import {
	StageWaterfall,
	stageDisplayName,
} from "@/components/app/stage-waterfall";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { projectParserTiming } from "@/core/parsing/parser-diagnostics";
import type { ApiDocument, ApiDocumentVersion, ApiJob } from "@/lib/api";
import { formatDateTime, formatDurationMs, formatFileSize } from "@/lib/format";
import { useInterfaceLanguage, useInterfaceText } from "@/lib/i18n/provider";
import { isParserReportDegraded } from "@/lib/parser-report-view.mjs";
import { cn } from "@/lib/utils";

type Props = {
	document: ApiDocument | null;
	versions: ApiDocumentVersion[];
	activeVersionId: string | null;
	desiredVersionId: string | null;
	versionsError: unknown;
	onRefreshVersions: () => Promise<unknown>;
	versionsLoading: boolean;
	job: ApiJob | null;
	jobLoading: boolean;
	busy: boolean;
	canWrite: boolean;
	actions: DetailAction[];
	onClose: () => void;
};

export function DocumentDetailSheet({
	document,
	versions,
	activeVersionId,
	desiredVersionId,
	versionsError,
	onRefreshVersions,
	versionsLoading,
	job,
	jobLoading,
	busy,
	canWrite,
	actions,
	onClose,
}: Props) {
	const t = useInterfaceText();
	const titleRef = useRef<HTMLHeadingElement>(null);
	const [versionsRefreshing, setVersionsRefreshing] = useState(false);
	const active = versions.find((version) => version.id === activeVersionId);
	const desired = versions.find((version) => version.id === desiredVersionId);
	const hasSeparateDesired = Boolean(
		activeVersionId && desiredVersionId && activeVersionId !== desiredVersionId,
	);

	async function refreshVersions() {
		setVersionsRefreshing(true);
		try {
			await onRefreshVersions();
		} finally {
			setVersionsRefreshing(false);
		}
	}

	return (
		<Sheet open={document != null} onOpenChange={(open) => !open && onClose()}>
			<SheetContent
				side="right"
				initialFocus={titleRef}
				className="w-full max-w-full! gap-0 sm:max-w-xl! [&>[data-slot=sheet-close]]:size-11 motion-reduce:transform-none motion-reduce:transition-none"
				showCloseButton
			>
				{document ? (
					<>
						<SheetHeader className="shrink-0 border-b px-5 py-5 sm:px-6">
							<SheetDescription className="mb-1 text-xs">
								{t("文档详情", "Document details")}
							</SheetDescription>
							<SheetTitle
								ref={titleRef}
								tabIndex={-1}
								className="max-h-32 overflow-y-auto pr-10 text-base leading-relaxed [overflow-wrap:anywhere] focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
							>
								{document.name}
							</SheetTitle>
						</SheetHeader>
						<ScrollArea
							className="min-h-0 flex-1"
							contentClassName="px-5 sm:px-6"
						>
							<section
								aria-label={t("版本概览", "Version overview")}
								className="space-y-3 py-5"
							>
								<h3 className="text-sm font-medium">
									{t("生效与目标版本", "Active and target versions")}
								</h3>
								{versionsError ? (
									<div className="space-y-2">
										<p role="alert" className="text-sm text-destructive">
											{t(
												"版本信息读取失败，当前版本关系尚未确认。",
												"Failed to load version information. Active and target versions could not be confirmed.",
											)}
										</p>
										<Button
											type="button"
											variant="outline"
											className="h-11"
											disabled={versionsRefreshing}
											aria-busy={versionsRefreshing}
											onClick={() => void refreshVersions()}
										>
											<RotateCcw data-icon="inline-start" aria-hidden />
											{t("重试读取版本", "Retry loading versions")}
										</Button>
									</div>
								) : versionsLoading ? (
									<p role="status" className="text-sm text-muted-foreground">
										{t("正在读取版本关系…", "Loading version status…")}
									</p>
								) : (
									<>
										<dl className="grid grid-cols-2 gap-4">
											<Detail
												label={t("当前生效", "Active version")}
												value={
													active
														? `v${active.version}`
														: activeVersionId
															? t(
																	"生效版本未在当前列表中",
																	"Active version not in current list",
																)
															: t("未设置生效版本", "No active version")
												}
											/>
											<Detail
												label={t("目标版本", "Target version")}
												value={
													desired
														? `v${desired.version}`
														: desiredVersionId
															? t(
																	"目标版本未在当前列表中",
																	"Target version not in current list",
																)
															: t("未设置目标版本", "No target version")
												}
											/>
											{activeVersionId && !active ? (
												<Detail
													className="col-span-2"
													label={t("生效版本 ID", "Active version ID")}
													value={activeVersionId}
												/>
											) : null}
											{desiredVersionId && !desired ? (
												<Detail
													className="col-span-2"
													label={t("目标版本 ID", "Target version ID")}
													value={desiredVersionId}
												/>
											) : null}
										</dl>
										{activeVersionId ? (
											<p className="border-l-2 border-primary pl-3 text-sm leading-relaxed">
												{hasSeparateDesired
													? t(
															`${active ? `v${active.version}` : "已有版本"} 仍为生效版本；${desired ? `目标 v${desired.version}` : "目标版本"} 尚未生效。`,
															`${active ? `v${active.version}` : "The existing version"} remains active; ${desired ? `target v${desired.version}` : "the target version"} is not active yet.`,
														)
													: active
														? t(
																`v${active.version} 为当前生效版本。`,
																`v${active.version} is the active version.`,
															)
														: t(
																"已设置生效版本，序号未包含在当前列表中。",
																"An active version is set, but its version number is not in the current list.",
															)}
											</p>
										) : (
											<p className="text-sm text-muted-foreground">
												{t(
													"当前未设置生效版本。",
													"No active version is currently set.",
												)}
											</p>
										)}
									</>
								)}
								<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
									<span>{t("文档处理状态", "Processing status")}</span>
									<DocumentStatusBadge
										status={document.status}
										parserReport={document.parser_report}
									/>
								</div>
								{document.error ? (
									<p
										role="alert"
										className="text-sm leading-relaxed text-destructive [overflow-wrap:anywhere]"
									>
										{document.error}
									</p>
								) : null}
							</section>

							<section
								aria-label={t("来源与文件", "Source and file")}
								className="space-y-4 border-t py-5"
							>
								<div className="flex items-center gap-2">
									<FileText
										className="size-4 text-muted-foreground"
										aria-hidden
									/>
									<h3 className="text-sm font-medium">
										{t("来源与文件", "Source and file")}
									</h3>
								</div>
								<dl className="grid grid-cols-2 gap-x-4 gap-y-4">
									<Detail
										className="col-span-2"
										label={t("记录文件名", "Recorded filename")}
										value={document.filename}
									/>
									<Detail
										label={t("文件类型", "File type")}
										value={
											document.content_type || t("未知类型", "Unknown type")
										}
									/>
									<Detail
										label={t("目标文件大小", "Target file size")}
										value={formatFileSize(document.size_bytes)}
									/>
									<Detail
										label={t("目标版本片段", "Target version chunks")}
										value={`${document.chunk_count} chunks`}
									/>
									<Detail
										label={t("目标原文件", "Target source file")}
										value={
											document.has_file
												? t("原文已保留", "Original file retained")
												: document.has_file === false
													? t("原文未保留", "Original file not retained")
													: t("保留状态未知", "Retention status unknown")
										}
									/>
									<Detail
										label={t("创建", "Created")}
										value={formatDateTime(document.created_at)}
									/>
									<Detail
										label={t("更新", "Updated")}
										value={formatDateTime(document.updated_at)}
									/>
								</dl>
								{hasSeparateDesired && !versionsError ? (
									<p className="text-xs leading-relaxed text-muted-foreground">
										{t(
											"文件大小、保留状态和解析报告对应目标版本；下载由服务端返回当前生效版本的原文件。",
											"File size, retention status, and parser report reflect the target version; downloads return the active version's original file.",
										)}
									</p>
								) : null}
								{document.has_file === false ? (
									<p className="text-sm leading-relaxed text-muted-foreground">
										{t(
											"目标版本未保留原文件，相关下载与重索引操作可能不可用。",
											"The target version has no retained original file; download and reindex actions may be unavailable.",
										)}
										{canWrite
											? t(
													"可用「替换文件」重新上传。",
													' Use "Replace file" to upload again.',
												)
											: ""}
									</p>
								) : null}
							</section>

							<JobTimeline job={job} loading={jobLoading} document={document} />
							<VersionHistory
								versions={versions}
								loading={versionsLoading}
								error={versionsError}
								activeVersionId={activeVersionId}
								desiredVersionId={desiredVersionId}
							/>
							<section
								aria-label={t("解析诊断", "Parser diagnostics")}
								className="space-y-3 border-t py-5"
							>
								<h3 className="text-sm font-medium">
									{t("解析诊断", "Parser diagnostics")}
								</h3>
								<ParserReportCard
									report={document.parser_report}
									parseStatus={document.parse_status}
								/>
							</section>
						</ScrollArea>
						<SheetFooter className="max-h-[35dvh] shrink-0 overflow-y-auto border-t bg-background px-5 py-3 sm:px-6">
							<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
								{actions.map((action) => {
									const Icon = action.icon;
									const highlight =
										action.id === "reindex" &&
										isParserReportDegraded(document.parser_report) &&
										Boolean(document.has_file);
									return (
										<AuthButton
											key={action.id}
											cap={action.cap}
											type="button"
											variant={
												highlight ? "default" : (action.variant ?? "outline")
											}
											className="h-11 min-w-11 rounded-md px-2 text-sm"
											disabled={action.disabled?.(document, busy) ?? false}
											onClick={() => action.run(document)}
										>
											<Icon data-icon="inline-start" aria-hidden />
											{action.label}
										</AuthButton>
									);
								})}
							</div>
						</SheetFooter>
					</>
				) : null}
			</SheetContent>
		</Sheet>
	);
}

const JOB_STATUS_LABELS: Record<string, readonly [zh: string, en: string]> = {
	queued: ["排队中", "Queued"],
	running: ["执行中", "Running"],
	cancelling: ["取消中", "Cancelling"],
	cancelled: ["已取消", "Cancelled"],
	completed: ["已完成", "Completed"],
	failed: ["失败", "Failed"],
	dead: ["重试已耗尽", "Retries exhausted"],
};

function JobTimeline({
	job,
	loading,
	document,
}: {
	job: ApiJob | null;
	loading: boolean;
	document: ApiDocument;
}) {
	const t = useInterfaceText();
	const { locale } = useInterfaceLanguage();
	const observedTotal =
		job?.started_at && job.finished_at
			? Date.parse(job.finished_at) - Date.parse(job.started_at)
			: null;
	const total =
		observedTotal != null &&
		Number.isFinite(observedTotal) &&
		observedTotal >= 0
			? observedTotal
			: null;
	const timing = projectParserTiming(
		(job?.parser_report?.metrics as Record<string, unknown> | undefined)
			?.parser_timing,
	);
	const status = job?.status ?? document.job_status;
	const stage = job?.stage ?? document.job_stage;
	const progress = job?.progress ?? document.job_progress;
	const statusLabel = status ? JOB_STATUS_LABELS[status] : undefined;

	return (
		<section
			aria-label={t("当前处理任务", "Current processing job")}
			className="space-y-4 border-t py-5"
		>
			<h3 className="text-sm font-medium">
				{t("当前处理任务", "Current processing job")}
			</h3>
			{loading ? (
				<p role="status" className="text-sm text-muted-foreground">
					{t("正在读取入库链路…", "Loading ingestion trace…")}
				</p>
			) : null}
			{status || stage ? (
				<dl className="grid grid-cols-2 gap-4">
					<Detail
						label={t("任务状态", "Job status")}
						value={
							status
								? statusLabel
									? t(...statusLabel)
									: status
								: t("未知", "Unknown")
						}
					/>
					<Detail
						label={t("当前阶段", "Current stage")}
						value={
							stage
								? stageDisplayName(stage, locale)
								: t("未提供", "Not provided")
						}
					/>
					{typeof progress === "number" &&
					Number.isFinite(progress) &&
					progress >= 0 &&
					progress <= 100 ? (
						<Detail
							label={t("任务进度", "Job progress")}
							value={`${progress}%`}
						/>
					) : null}
					{total != null ? (
						<Detail
							label={t("执行耗时", "Elapsed time")}
							value={formatDurationMs(total)}
						/>
					) : null}
				</dl>
			) : null}
			{job ? (
				<>
					<dl className="grid grid-cols-2 gap-4">
						<Detail
							className="col-span-2"
							label={t("任务 ID", "Job ID")}
							value={job.id}
						/>
						<Detail label={t("任务类型", "Job type")} value={job.type} />
						<Detail
							label={t("尝试次数 / 上限", "Attempts / Max")}
							value={`${job.attempt} / ${job.max_attempts}`}
						/>
						{job.progress_current != null && job.progress_total != null ? (
							<Detail
								label={t("已处理 / 总量", "Processed / Total")}
								value={`${job.progress_current} / ${job.progress_total}`}
							/>
						) : null}
					</dl>
					<div className="space-y-2">
						<h4 className="text-xs font-medium text-muted-foreground">
							{t("入库链路", "Ingestion pipeline")}
						</h4>
						<p className="text-xs text-muted-foreground">
							{t(
								"顺序累计耗时，非绝对时间轴",
								"Cumulative stage durations, not an absolute timeline",
							)}
						</p>
						<StageWaterfall
							stages={job.stage_runs ?? []}
							compact
							className="[&_span]:text-xs [&_p]:text-xs motion-reduce:[&_*]:animate-none motion-reduce:[&_*]:transition-none"
						/>
					</div>
					{timing ? (
						<dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
							{[
								[
									t("本地 PDF 分析", "Local PDF analysis"),
									formatDurationMs(timing.analysis_ms),
								],
								[
									t("提交文件与任务", "File & job submission"),
									formatDurationMs(timing.submission_ms),
								],
								[
									t("任务等待（含轮询）", "Provider wait (incl. polling)"),
									formatDurationMs(timing.provider_wait_ms),
								],
								[
									t("结果获取与转换", "Result fetch & conversion"),
									formatDurationMs(timing.result_fetch_ms),
								],
								[
									t("轮询 / 重试", "Polls / Retries"),
									`${timing.poll_count} / ${timing.retry_count}`,
								],
							].map(([label, value]) => (
								<Detail key={label} label={label} value={value} />
							))}
						</dl>
					) : null}
					<dl className="grid grid-cols-2 gap-4">
						<Detail
							label={t("创建", "Created")}
							value={formatDateTime(job.created_at)}
						/>
						<Detail
							label={t("开始", "Started")}
							value={
								job.started_at
									? formatDateTime(job.started_at)
									: t("未记录", "Not recorded")
							}
						/>
						<Detail
							label={t("结束", "Finished")}
							value={
								job.finished_at
									? formatDateTime(job.finished_at)
									: t("未记录", "Not recorded")
							}
						/>
					</dl>
					{job.error_code || job.error ? (
						<div
							role="alert"
							className="space-y-1 border-l-2 border-destructive pl-3 text-sm text-destructive [overflow-wrap:anywhere]"
						>
							{job.error_code ? (
								<p className="font-mono text-xs">{job.error_code}</p>
							) : null}
							{job.error ? <p>{job.error}</p> : null}
						</div>
					) : null}
				</>
			) : !loading ? (
				<p className="text-sm text-muted-foreground">
					{document.job_id
						? t("未取得任务详情", "Job details unavailable")
						: t("暂无关联任务", "No associated job")}
				</p>
			) : null}
		</section>
	);
}

function Detail({
	label,
	value,
	className,
}: {
	label: string;
	value: string;
	className?: string;
}) {
	return (
		<div className={cn("min-w-0", className)}>
			<dt className="text-xs leading-relaxed text-muted-foreground">{label}</dt>
			<dd className="mt-1 text-sm leading-relaxed [overflow-wrap:anywhere]">
				{value}
			</dd>
		</div>
	);
}

function VersionHistory({
	versions,
	loading,
	error,
	activeVersionId,
	desiredVersionId,
}: {
	versions: ApiDocumentVersion[];
	loading: boolean;
	error: unknown;
	activeVersionId: string | null;
	desiredVersionId: string | null;
}) {
	const t = useInterfaceText();
	return (
		<section
			aria-label={t("版本历史", "Version history")}
			className="space-y-3 border-t py-5"
		>
			<h3 className="text-sm font-medium">
				{t("版本历史", "Version history")}
			</h3>
			{error ? (
				<p className="text-sm text-muted-foreground">
					{t("版本历史暂不可用", "Version history unavailable")}
				</p>
			) : loading ? (
				<p role="status" className="text-sm text-muted-foreground">
					{t("正在读取版本历史…", "Loading version history…")}
				</p>
			) : versions.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					{t("未取得版本记录", "No version records found")}
				</p>
			) : (
				<ul className="divide-y divide-border">
					{versions.map((version) => (
						<li key={version.id} className="py-3 first:pt-0 last:pb-0">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<div className="flex flex-wrap items-center gap-2 text-xs">
									<span className="font-mono text-sm font-medium">
										v{version.version}
									</span>
									{version.id === activeVersionId ? (
										<span className="text-primary">
											{t("当前生效", "Active")}
										</span>
									) : null}
									{version.id === desiredVersionId ? (
										<span className="text-muted-foreground">
											{t("目标版本", "Target")}
										</span>
									) : null}
								</div>
								<DocumentStatusBadge status={version.status} />
							</div>
							<p className="mt-2 text-xs text-muted-foreground">
								{formatDateTime(version.created_at)}
								{version.chunk_count != null
									? ` · ${version.chunk_count} chunks`
									: ""}
							</p>
							<details className="group mt-1">
								<summary className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
									<ChevronRight
										className="size-4 shrink-0 group-open:rotate-90"
										aria-hidden
									/>
									{t("版本明细", "Version details")}
								</summary>
								<dl className="grid grid-cols-2 gap-3 pb-2">
									<Detail
										className="col-span-2"
										label={t("版本 ID", "Version ID")}
										value={version.id}
									/>
									<Detail
										className="col-span-2"
										label="Generation"
										value={version.generation_id}
									/>
									<Detail
										label={t("大小", "Size")}
										value={formatFileSize(version.size_bytes)}
									/>
									{version.parser_backend ? (
										<Detail
											label={t("解析后端", "Parser backend")}
											value={version.parser_backend}
										/>
									) : null}
									{version.pipeline_version ? (
										<Detail
											label={t("流水线版本", "Pipeline version")}
											value={version.pipeline_version}
										/>
									) : null}
									{version.activated_at ? (
										<Detail
											label={t("生效时间", "Activated")}
											value={formatDateTime(version.activated_at)}
										/>
									) : null}
									{version.failure_code ? (
										<Detail
											label={t("失败代码", "Failure code")}
											value={version.failure_code}
										/>
									) : null}
								</dl>
							</details>
							{version.error ? (
								<p className="text-sm text-destructive [overflow-wrap:anywhere]">
									{version.error}
								</p>
							) : null}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
