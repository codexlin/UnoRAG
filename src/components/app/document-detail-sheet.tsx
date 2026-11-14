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
								文档详情
							</SheetDescription>
							<SheetTitle
								ref={titleRef}
								tabIndex={-1}
								className="max-h-32 overflow-y-auto pr-10 text-base leading-relaxed [overflow-wrap:anywhere] focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
							>
								{document.name}
							</SheetTitle>
						</SheetHeader>
						<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 sm:px-6">
							<section aria-label="版本概览" className="space-y-3 py-5">
								<h3 className="text-sm font-medium">生效与目标版本</h3>
								{versionsError ? (
									<div className="space-y-2">
										<p role="alert" className="text-sm text-destructive">
											版本信息读取失败，当前版本关系尚未确认。
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
											重试读取版本
										</Button>
									</div>
								) : versionsLoading ? (
									<p role="status" className="text-sm text-muted-foreground">
										正在读取版本关系…
									</p>
								) : (
									<>
										<dl className="grid grid-cols-2 gap-4">
											<Detail
												label="当前生效"
												value={
													active
														? `v${active.version}`
														: activeVersionId
															? "生效版本未在当前列表中"
															: "未设置生效版本"
												}
											/>
											<Detail
												label="目标版本"
												value={
													desired
														? `v${desired.version}`
														: desiredVersionId
															? "目标版本未在当前列表中"
															: "未设置目标版本"
												}
											/>
											{activeVersionId && !active ? (
												<Detail
													className="col-span-2"
													label="生效版本 ID"
													value={activeVersionId}
												/>
											) : null}
											{desiredVersionId && !desired ? (
												<Detail
													className="col-span-2"
													label="目标版本 ID"
													value={desiredVersionId}
												/>
											) : null}
										</dl>
										{activeVersionId ? (
											<p className="border-l-2 border-primary pl-3 text-sm leading-relaxed">
												{hasSeparateDesired
													? `${active ? `v${active.version}` : "已有版本"} 仍为生效版本；${desired ? `目标 v${desired.version}` : "目标版本"} 尚未生效。`
													: active
														? `v${active.version} 为当前生效版本。`
														: "已设置生效版本，序号未包含在当前列表中。"}
											</p>
										) : (
											<p className="text-sm text-muted-foreground">
												当前未设置生效版本。
											</p>
										)}
									</>
								)}
								<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
									<span>文档处理状态</span>
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
								aria-label="来源与文件"
								className="space-y-4 border-t py-5"
							>
								<div className="flex items-center gap-2">
									<FileText
										className="size-4 text-muted-foreground"
										aria-hidden
									/>
									<h3 className="text-sm font-medium">来源与文件</h3>
								</div>
								<dl className="grid grid-cols-2 gap-x-4 gap-y-4">
									<Detail
										className="col-span-2"
										label="记录文件名"
										value={document.filename}
									/>
									<Detail
										label="文件类型"
										value={document.content_type || "未知类型"}
									/>
									<Detail
										label="目标文件大小"
										value={formatFileSize(document.size_bytes)}
									/>
									<Detail
										label="目标版本片段"
										value={`${document.chunk_count} chunks`}
									/>
									<Detail
										label="目标原文件"
										value={
											document.has_file
												? "原文已保留"
												: document.has_file === false
													? "原文未保留"
													: "保留状态未知"
										}
									/>
									<Detail
										label="创建"
										value={formatDateTime(document.created_at)}
									/>
									<Detail
										label="更新"
										value={formatDateTime(document.updated_at)}
									/>
								</dl>
								{hasSeparateDesired && !versionsError ? (
									<p className="text-xs leading-relaxed text-muted-foreground">
										文件大小、保留状态和解析报告对应目标版本；下载由服务端返回当前生效版本的原文件。
									</p>
								) : null}
								{document.has_file === false ? (
									<p className="text-sm leading-relaxed text-muted-foreground">
										目标版本未保留原文件，相关下载与重索引操作可能不可用。
										{canWrite ? "可用「替换文件」重新上传。" : ""}
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
								aria-label="解析诊断"
								className="space-y-3 border-t py-5"
							>
								<h3 className="text-sm font-medium">解析诊断</h3>
								<ParserReportCard
									report={document.parser_report}
									parseStatus={document.parse_status}
								/>
							</section>
						</div>
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

const JOB_STATUS_LABELS: Record<string, string> = {
	queued: "排队中",
	running: "执行中",
	cancelling: "取消中",
	cancelled: "已取消",
	completed: "已完成",
	failed: "失败",
	dead: "重试已耗尽",
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

	return (
		<section aria-label="当前处理任务" className="space-y-4 border-t py-5">
			<h3 className="text-sm font-medium">当前处理任务</h3>
			{loading ? (
				<p role="status" className="text-sm text-muted-foreground">
					正在读取入库链路…
				</p>
			) : null}
			{status || stage ? (
				<dl className="grid grid-cols-2 gap-4">
					<Detail
						label="任务状态"
						value={status ? (JOB_STATUS_LABELS[status] ?? status) : "未知"}
					/>
					<Detail
						label="当前阶段"
						value={stage ? stageDisplayName(stage) : "未提供"}
					/>
					{typeof progress === "number" &&
					Number.isFinite(progress) &&
					progress >= 0 &&
					progress <= 100 ? (
						<Detail label="任务进度" value={`${progress}%`} />
					) : null}
					{total != null ? (
						<Detail label="执行耗时" value={formatDurationMs(total)} />
					) : null}
				</dl>
			) : null}
			{job ? (
				<>
					<dl className="grid grid-cols-2 gap-4">
						<Detail className="col-span-2" label="任务 ID" value={job.id} />
						<Detail label="任务类型" value={job.type} />
						<Detail
							label="尝试次数 / 上限"
							value={`${job.attempt} / ${job.max_attempts}`}
						/>
						{job.progress_current != null && job.progress_total != null ? (
							<Detail
								label="已处理 / 总量"
								value={`${job.progress_current} / ${job.progress_total}`}
							/>
						) : null}
					</dl>
					<div className="space-y-2">
						<h4 className="text-xs font-medium text-muted-foreground">
							入库链路
						</h4>
						<p className="text-xs text-muted-foreground">
							顺序累计耗时，非绝对时间轴
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
								["本地 PDF 分析", formatDurationMs(timing.analysis_ms)],
								["提交文件与任务", formatDurationMs(timing.submission_ms)],
								[
									"任务等待（含轮询）",
									formatDurationMs(timing.provider_wait_ms),
								],
								["结果获取与转换", formatDurationMs(timing.result_fetch_ms)],
								["轮询 / 重试", `${timing.poll_count} / ${timing.retry_count}`],
							].map(([label, value]) => (
								<Detail key={label} label={label} value={value} />
							))}
						</dl>
					) : null}
					<dl className="grid grid-cols-2 gap-4">
						<Detail label="创建" value={formatDateTime(job.created_at)} />
						<Detail
							label="开始"
							value={job.started_at ? formatDateTime(job.started_at) : "未记录"}
						/>
						<Detail
							label="结束"
							value={
								job.finished_at ? formatDateTime(job.finished_at) : "未记录"
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
					{document.job_id ? "未取得任务详情" : "暂无关联任务"}
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
	return (
		<section aria-label="版本历史" className="space-y-3 border-t py-5">
			<h3 className="text-sm font-medium">版本历史</h3>
			{error ? (
				<p className="text-sm text-muted-foreground">版本历史暂不可用</p>
			) : loading ? (
				<p role="status" className="text-sm text-muted-foreground">
					正在读取版本历史…
				</p>
			) : versions.length === 0 ? (
				<p className="text-sm text-muted-foreground">未取得版本记录</p>
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
										<span className="text-primary">当前生效</span>
									) : null}
									{version.id === desiredVersionId ? (
										<span className="text-muted-foreground">目标版本</span>
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
									版本明细
								</summary>
								<dl className="grid grid-cols-2 gap-3 pb-2">
									<Detail
										className="col-span-2"
										label="版本 ID"
										value={version.id}
									/>
									<Detail
										className="col-span-2"
										label="Generation"
										value={version.generation_id}
									/>
									<Detail
										label="大小"
										value={formatFileSize(version.size_bytes)}
									/>
									{version.parser_backend ? (
										<Detail label="解析后端" value={version.parser_backend} />
									) : null}
									{version.pipeline_version ? (
										<Detail
											label="流水线版本"
											value={version.pipeline_version}
										/>
									) : null}
									{version.activated_at ? (
										<Detail
											label="生效时间"
											value={formatDateTime(version.activated_at)}
										/>
									) : null}
									{version.failure_code ? (
										<Detail label="失败代码" value={version.failure_code} />
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
