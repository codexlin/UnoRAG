"use client";

import { AuthButton } from "@/components/app/auth-button";
import {
	DocumentStatusBadge,
	ParserReportCard,
} from "@/components/app/document-status";
import type { DetailAction } from "@/components/app/library-doc-actions";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import type { ApiDocument, ApiDocumentVersion } from "@/lib/api";
import { formatDateTime, formatFileSize } from "@/lib/format";
import { isParserReportDegraded } from "@/lib/parser-report-view.mjs";

type Props = {
	document: ApiDocument | null;
	versions: ApiDocumentVersion[];
	versionsLoading: boolean;
	busy: boolean;
	canWrite: boolean;
	actions: DetailAction[];
	onClose: () => void;
};

export function DocumentDetailSheet({
	document,
	versions,
	versionsLoading,
	busy,
	canWrite,
	actions,
	onClose,
}: Props) {
	return (
		<Sheet open={document != null} onOpenChange={(open) => !open && onClose()}>
			<SheetContent side="right" className="w-full sm:max-w-md" showCloseButton>
				{document ? (
					<>
						<SheetHeader className="border-b border-border/70">
							<SheetTitle className="pr-8">{document.name}</SheetTitle>
							<SheetDescription>
								{document.filename} · {document.content_type || "未知类型"}
							</SheetDescription>
						</SheetHeader>
						<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-2">
							<div className="flex flex-wrap items-center gap-2">
								<DocumentStatusBadge
									status={document.status}
									parserReport={document.parser_report}
								/>
								<span className="text-meta font-mono text-muted-foreground">
									{document.chunk_count} chunks
								</span>
								<span className="text-meta font-mono text-muted-foreground">
									{formatFileSize(document.size_bytes)}
								</span>
								<span
									className={
										document.has_file
											? "text-meta rounded-md border border-cite/30 bg-cite/10 px-2 py-0.5 font-mono text-cite"
											: "text-meta rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-muted-foreground"
									}
								>
									{document.has_file ? "原文已保留" : "原文未保留"}
								</span>
							</div>

							<dl className="grid gap-3 text-ui">
								<Detail
									label="大小"
									value={formatFileSize(document.size_bytes)}
								/>
								<Detail
									label="创建"
									value={formatDateTime(document.created_at)}
								/>
								<Detail
									label="更新"
									value={formatDateTime(document.updated_at)}
								/>
								{typeof document.parser_report?.parser === "string" ||
								document.parse_status?.parser_label ? (
									<Detail
										label="解析器"
										value={
											document.parse_status?.parser_label ||
											String(document.parser_report?.parser)
										}
									/>
								) : null}
								{document.parse_status?.task_status ? (
									<Detail
										label="入库状态"
										value={`${document.parse_status.task_status}${document.job_progress != null ? ` · ${document.job_progress}%` : ""}`}
									/>
								) : null}
							</dl>

							{document.error ? (
								<div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
									<p className="text-meta font-mono uppercase tracking-wide text-destructive">
										错误
									</p>
									<p className="text-ui mt-1 text-destructive">
										{document.error}
									</p>
								</div>
							) : null}

							<VersionHistory versions={versions} loading={versionsLoading} />

							{document.parser_report ? (
								<ParserReportCard
									report={document.parser_report}
									parseStatus={document.parse_status}
								/>
							) : document.parse_status?.task_status ? (
								<div className="rounded-md border border-border/80 bg-muted/30 px-3 py-2">
									<p className="text-meta font-mono uppercase tracking-wide text-muted-foreground">
										入库进度
									</p>
									<p className="text-ui mt-1">
										{document.parse_status.task_status}
									</p>
								</div>
							) : null}

							{!document.has_file ? (
								<p className="text-ui text-muted-foreground">
									此文档上传时未落盘原文，无法下载或重索引。
									{canWrite ? "可用「替换文件」重新上传。" : ""}
								</p>
							) : null}
						</div>
						<SheetFooter className="border-t border-border/70">
							<div className="flex flex-wrap gap-2">
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
											className="rounded-md"
											disabled={action.disabled?.(document, busy) ?? false}
											onClick={() => action.run(document)}
										>
											<Icon data-icon="inline-start" />
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

function Detail({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<dt className="text-meta font-mono text-muted-foreground uppercase tracking-wide">
				{label}
			</dt>
			<dd className="mt-0.5 font-mono text-meta">{value}</dd>
		</div>
	);
}

function VersionHistory({
	versions,
	loading,
}: {
	versions: ApiDocumentVersion[];
	loading: boolean;
}) {
	return (
		<div className="rounded-md border border-border/80 bg-muted/20 px-3 py-2">
			<p className="text-meta font-mono uppercase tracking-wide text-muted-foreground">
				版本历史
			</p>
			{loading ? (
				<p className="text-ui mt-2 text-muted-foreground">加载中…</p>
			) : versions.length === 0 ? (
				<p className="text-ui mt-2 text-muted-foreground">暂无版本</p>
			) : (
				<ul className="mt-2 space-y-2">
					{versions.map((version) => (
						<li
							key={version.id}
							className="flex items-start justify-between gap-2 border-t border-border/50 pt-2 first:border-t-0 first:pt-0"
						>
							<div className="min-w-0">
								<p className="font-mono text-meta">
									v{version.version}
									{version.is_active ? " · active" : ""}
									{version.is_desired && !version.is_active ? " · desired" : ""}
								</p>
								<p className="truncate text-meta text-muted-foreground">
									{version.generation_id.slice(0, 8)}…
									{version.chunk_count != null
										? ` · ${version.chunk_count} chunks`
										: ""}
								</p>
							</div>
							<DocumentStatusBadge status={version.status} />
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
