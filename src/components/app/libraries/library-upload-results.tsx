import {
	CheckCircle2,
	CircleAlert,
	Clock3,
	FileText,
	Loader2,
	X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatDurationMs } from "@/lib/format";

export type DocumentUploadResult = {
	id: number;
	filename: string;
	status: "submitting" | "accepted" | "ready" | "failed";
	durationMs: number | null;
	docId?: string;
	error?: string;
};

export type DocumentUploadBatch = {
	id: number;
	libraryId: string;
	libraryName: string;
	files: DocumentUploadResult[];
	durationMs: number | null;
};

const uploadStates = {
	submitting: { label: "提交中", icon: Loader2 },
	accepted: { label: "已接受", icon: Clock3 },
	ready: { label: "已就绪", icon: CheckCircle2 },
	failed: { label: "提交失败", icon: CircleAlert },
};

export function LibraryUploadResults({
	batch,
	viewableDocumentIds,
	onView,
	onDismiss,
}: {
	batch: DocumentUploadBatch;
	viewableDocumentIds: ReadonlySet<string>;
	onView: (docId: string) => void;
	onDismiss: () => void;
}) {
	return (
		<section
			aria-label="本次上传结果"
			className="min-w-0 border-b px-4 py-4 sm:px-6"
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 space-y-1">
					<h4 className="break-words text-sm font-medium [overflow-wrap:anywhere]">
						本次上传 · {batch.libraryName}
					</h4>
					<p role="status" className="text-xs text-muted-foreground">
						{batch.files.length} 个文件 ·{" "}
						{batch.durationMs == null
							? "提交中"
							: `提交耗时 ${formatDurationMs(batch.durationMs)}`}
					</p>
				</div>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="size-11"
					aria-label="关闭上传结果"
					title="关闭上传结果（不取消后台任务）"
					onClick={onDismiss}
				>
					<X aria-hidden />
				</Button>
			</div>
			<ul
				aria-live="polite"
				aria-relevant="additions text"
				className="mt-2 max-h-64 divide-y overflow-y-auto"
			>
				{batch.files.map((file) => {
					const { label, icon: Icon } = uploadStates[file.status];
					return (
						<li
							key={file.id}
							className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
						>
							<div className="min-w-0 flex-1 basis-40">
								<p className="break-words text-sm [overflow-wrap:anywhere]">
									{file.filename}
								</p>
								{file.error ? (
									<p className="mt-1 break-words text-xs text-destructive [overflow-wrap:anywhere]">
										{file.error}
									</p>
								) : null}
							</div>
							<div className="flex flex-wrap items-center gap-2 text-xs">
								<span
									className={
										file.status === "failed"
											? "inline-flex items-center gap-1 text-destructive"
											: "inline-flex items-center gap-1 text-muted-foreground"
									}
								>
									<Icon
										aria-hidden
										className={
											file.status === "submitting"
												? "size-3.5 animate-spin motion-reduce:animate-none"
												: "size-3.5"
										}
									/>
									{label}
								</span>
								{file.durationMs != null ? (
									<span className="tabular-nums text-muted-foreground">
										提交 {formatDurationMs(file.durationMs)}
									</span>
								) : null}
								{file.docId && viewableDocumentIds.has(file.docId) ? (
									<Button
										type="button"
										variant="ghost"
										className="h-11"
										aria-label={`查看文档：${file.filename}`}
										onClick={() => file.docId && onView(file.docId)}
									>
										<FileText aria-hidden data-icon="inline-start" />
										查看文档
									</Button>
								) : null}
							</div>
						</li>
					);
				})}
			</ul>
			{batch.files.some((file) => file.status === "accepted") ? (
				<p className="mt-2 text-xs text-muted-foreground">
					已接受表示提交成功，不代表索引完成。
				</p>
			) : null}
		</section>
	);
}
