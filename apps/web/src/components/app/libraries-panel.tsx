"use client";

import {
	FileUp,
	MoreHorizontal,
	Pencil,
	Plus,
	RefreshCw,
	Trash2,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { AuthButton } from "@/components/app/auth-button";
import { Can, useCan } from "@/components/app/can";
import { DocumentAclDialog } from "@/components/app/document-acl-dialog";
import { useIngestJobs } from "@/components/app/ingest-jobs-provider";
import {
	buildDetailActions,
	type DocActionContext,
	resolveDocActions,
} from "@/components/app/library-doc-actions";
import { useSession } from "@/components/app/session-provider";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useLibraries } from "@/hooks/use-libraries";
import {
	type ApiDocument,
	type ApiDocumentVersion,
	type ApiLibrary,
	cancelJob,
	createLibrary,
	deleteDocument,
	deleteLibrary,
	downloadDocument,
	fetchDocuments,
	fetchDocumentVersions,
	isAbortError,
	reindexDocument,
	replaceDocument,
	retryJob,
	updateLibrary,
	uploadDocument,
} from "@/lib/api";
import { filterByCap } from "@/lib/client-permissions";
import { TERMINAL_JOB_STATUSES } from "@/lib/document-lifecycle-contract";
import { formatDateTime, formatDurationMs, formatFileSize } from "@/lib/format";
import {
	formatParserReportView,
	isParserReportDegraded,
	PARSE_DEGRADED_REINDEX_HINT,
	resolveDocumentStatusDisplay,
} from "@/lib/parser-report-view.mjs";
import { cn } from "@/lib/utils";

function DocStatusBadge({
	status,
	parserReport,
}: {
	status: string;
	parserReport?: ApiDocument["parser_report"];
}) {
	const display = resolveDocumentStatusDisplay(status, parserReport);
	const tone = display.tone;
	return (
		<span
			className={cn(
				"text-meta rounded-md border px-2 py-0.5 font-mono uppercase",
				tone === "ready" && "border-cite/30 bg-cite/10 text-cite",
				tone === "processing" &&
					"border-survey/35 bg-accent text-accent-foreground",
				tone === "failed" &&
					"border-destructive/30 bg-destructive/10 text-destructive",
				tone === "degraded" &&
					"border-survey/35 bg-accent text-accent-foreground",
				tone === "cancelled" && "border-border bg-muted text-muted-foreground",
				tone === "indexing" &&
					"border-survey/35 bg-accent text-accent-foreground",
				tone === "empty" && "border-border bg-muted text-muted-foreground",
				tone === "deleting" &&
					"border-destructive/30 bg-destructive/10 text-destructive",
				![
					"ready",
					"processing",
					"failed",
					"degraded",
					"cancelled",
					"indexing",
					"empty",
					"deleting",
				].includes(tone) && "border-border bg-muted text-muted-foreground",
			)}
		>
			{display.label}
		</span>
	);
}

function LibStatusDot({ status }: { status: string }) {
	return (
		<span
			className={cn(
				"size-2 shrink-0 rounded-full",
				status === "ready" && "bg-cite",
				status === "indexing" && "bg-survey",
				status === "degraded" && "bg-survey",
				status === "failed" && "bg-destructive",
				status === "empty" && "bg-muted-foreground/40",
				!["ready", "indexing", "degraded", "failed", "empty"].includes(
					status,
				) && "bg-muted-foreground/40",
			)}
			aria-hidden
		/>
	);
}

function ParserReportCard({
	report,
}: {
	report: NonNullable<ApiDocument["parser_report"]>;
}) {
	const reportView = formatParserReportView(report);
	return (
		<div
			className={cn(
				"rounded-md border px-3 py-2",
				reportView.degraded
					? "border-survey/40 bg-accent/40"
					: "border-border/80 bg-muted/30",
			)}
		>
			<div className="flex flex-wrap items-center gap-2">
				<p className="text-meta font-mono uppercase tracking-wide text-muted-foreground">
					{reportView.title}
				</p>
				{reportView.degraded ? (
					<span className="text-meta rounded-md border border-survey/35 bg-accent px-1.5 py-0.5 font-mono text-accent-foreground">
						降级处理
					</span>
				) : null}
			</div>
			{reportView.summaries.map((line) => (
				<p
					key={line}
					className={cn(
						"text-ui mt-1",
						line.startsWith("建议 OCR")
							? "text-muted-foreground"
							: "text-survey",
					)}
				>
					{line}
				</p>
			))}
			{reportView.degraded ? (
				<p className="text-ui mt-1.5 text-muted-foreground">
					{PARSE_DEGRADED_REINDEX_HINT}
				</p>
			) : null}
			{reportView.techDetails.length > 0 ? (
				<details className="group mt-2 rounded-md border border-border/60 bg-background/40">
					<summary className="cursor-pointer list-none px-2 py-1.5 font-mono text-meta text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground [&::-webkit-details-marker]:hidden">
						技术详情
					</summary>
					<ul className="text-ui space-y-1 border-t border-border/50 px-2 py-1.5 text-muted-foreground">
						{reportView.techDetails.map((detail) => (
							<li
								key={detail}
								className="break-all font-mono text-[11px] leading-relaxed"
							>
								{detail}
							</li>
						))}
					</ul>
				</details>
			) : null}
			{reportView.empty ? (
				<p className="text-ui mt-1 text-muted-foreground">
					解析完成，无额外提示
				</p>
			) : null}
		</div>
	);
}

export function LibrariesPanel() {
	const { caps } = useSession();
	const canWriteLibraries = useCan("writeLibraries");
	const canManageLibraries = useCan("manageLibraries");
	const {
		libraries,
		error: librariesError,
		loading,
		refresh: refreshLibraries,
	} = useLibraries();
	const { tick: ingestTick, trackProcessing } = useIngestJobs();
	const [selectedId, setSelectedId] = useState<string>("");
	const [documents, setDocuments] = useState<ApiDocument[]>([]);
	const [uploading, setUploading] = useState(false);
	const [savingLibrary, setSavingLibrary] = useState(false);
	const [busyDocId, setBusyDocId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [lastUploadMs, setLastUploadMs] = useState<number | null>(null);
	const [detailDocId, setDetailDocId] = useState<string | null>(null);
	const [deleteDocId, setDeleteDocId] = useState<string | null>(null);
	const [aclDoc, setAclDoc] = useState<ApiDocument | null>(null);
	const [replaceDoc, setReplaceDoc] = useState<ApiDocument | null>(null);
	const [replaceFile, setReplaceFile] = useState<File | null>(null);
	const [replacing, setReplacing] = useState(false);
	// open 与 mode 分离：关闭时只关 open，保留 mode/文案，避免关闭动画闪成「新建」
	const [libraryDialogOpen, setLibraryDialogOpen] = useState(false);
	const [libraryDialogMode, setLibraryDialogMode] = useState<"create" | "edit">(
		"create",
	);
	const [editingLibrary, setEditingLibrary] = useState<ApiLibrary | null>(null);
	const [libraryName, setLibraryName] = useState("");
	const [libraryDescription, setLibraryDescription] = useState("");
	const [libraryDocumentProfile, setLibraryDocumentProfile] = useState("auto");
	const [libraryScanHandling, setLibraryScanHandling] = useState("auto");
	const [libraryAdvancedOpen, setLibraryAdvancedOpen] = useState(false);
	const [libraryFormError, setLibraryFormError] = useState<string | null>(null);
	const [deleteLibraryTarget, setDeleteLibraryTarget] =
		useState<ApiLibrary | null>(null);
	const [deletingLibrary, setDeletingLibrary] = useState(false);
	const [versionRows, setVersionRows] = useState<ApiDocumentVersion[]>([]);
	const [versionsLoading, setVersionsLoading] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const replaceInputRef = useRef<HTMLInputElement>(null);

	const selectedLibrary = useMemo(
		() => libraries.find((item) => item.id === selectedId) ?? null,
		[libraries, selectedId],
	);

	const detailDoc = useMemo(
		() => documents.find((doc) => doc.id === detailDocId) ?? null,
		[documents, detailDocId],
	);

	const deleteDoc = useMemo(
		() => documents.find((doc) => doc.id === deleteDocId) ?? null,
		[documents, deleteDocId],
	);

	const loadDocuments = useCallback(
		async (libraryId: string, signal?: AbortSignal) => {
			if (!libraryId) {
				setDocuments([]);
				return;
			}
			try {
				const items = await fetchDocuments(libraryId, signal);
				if (signal?.aborted) return;
				setDocuments(items);
				setError(null);
			} catch (err) {
				if (signal?.aborted || isAbortError(err)) return;
				setDocuments([]);
				const message = err instanceof Error ? err.message : "文档列表加载失败";
				// 库已不存在 / 无库：不当成页面错误，静默清空
				if (/404|not found/i.test(message)) {
					setError(null);
					return;
				}
				setError(`文档列表加载失败：${message}`);
			}
		},
		[],
	);

	useEffect(() => {
		if (libraries.length === 0) {
			if (selectedId) setSelectedId("");
			setDocuments([]);
			return;
		}
		const stillExists = libraries.some((item) => item.id === selectedId);
		if (!selectedId || !stillExists) {
			setSelectedId(libraries[0].id);
		}
	}, [libraries, selectedId]);

	useEffect(() => {
		if (!selectedId) {
			setDocuments([]);
			return;
		}
		// 库列表尚未包含该 id（刚删光 / 切换中）不请求，避免 404 噪点
		if (!libraries.some((item) => item.id === selectedId)) {
			return;
		}
		const controller = new AbortController();
		void loadDocuments(selectedId, controller.signal);
		return () => controller.abort();
	}, [selectedId, libraries, loadDocuments]);

	// 全局索引轮询 tick：刷新当前库文档表（完成 toast 由 IngestJobsProvider 负责）
	useEffect(() => {
		if (!selectedId || ingestTick === 0) return;
		const selected = libraries.find((item) => item.id === selectedId);
		if (selected?.status !== "indexing") return;
		void loadDocuments(selectedId);
	}, [ingestTick, selectedId, libraries, loadDocuments]);

	useEffect(() => {
		// ingestTick intentionally refreshes versions while ingest progresses.
		void ingestTick;
		if (!detailDocId || !selectedId) {
			setVersionRows([]);
			return;
		}
		const controller = new AbortController();
		setVersionsLoading(true);
		void fetchDocumentVersions({
			libraryId: selectedId,
			docId: detailDocId,
			signal: controller.signal,
		})
			.then((payload) => {
				if (!controller.signal.aborted) {
					setVersionRows(payload.versions);
				}
			})
			.catch((err) => {
				if (!isAbortError(err) && !controller.signal.aborted) {
					setVersionRows([]);
				}
			})
			.finally(() => {
				if (!controller.signal.aborted) setVersionsLoading(false);
			});
		return () => controller.abort();
	}, [detailDocId, selectedId, ingestTick]);

	async function loadLibraries() {
		setError(null);
		await refreshLibraries();
	}

	async function onUploadFiles(files: FileList | null) {
		if (!files?.length || !selectedId) return;
		setUploading(true);
		setError(null);
		const started = performance.now();
		const fileList = Array.from(files);
		try {
			const settled = await Promise.allSettled(
				fileList.map((file) =>
					uploadDocument({
						libraryId: selectedId,
						file,
					}),
				),
			);
			const elapsed = Math.round(performance.now() - started);
			setLastUploadMs(elapsed);
			const ok = settled.filter(
				(
					item,
				): item is PromiseFulfilledResult<
					Awaited<ReturnType<typeof uploadDocument>>
				> => item.status === "fulfilled",
			);
			const failed = settled.filter((item) => item.status === "rejected");
			const acceptedDocs = ok
				.filter(
					(item) => item.value.accepted || item.value.status === "processing",
				)
				.map((item) => ({
					id: item.value.doc_id,
					name: item.value.title,
				}));
			if (acceptedDocs.length > 0) {
				trackProcessing(acceptedDocs);
			}
			const accepted = acceptedDocs.length;
			const ready = ok.filter((item) => item.value.status === "ready").length;
			if (ok.length > 0) {
				if (accepted > 0) {
					toast.success(
						`已提交 ${accepted} 个文件索引${ready ? `，${ready} 个已就绪` : ""} · ${formatDurationMs(elapsed)}`,
					);
				} else {
					toast.success(
						`已上传 ${ok.length} 个文件 · ${formatDurationMs(elapsed)}`,
					);
				}
			}
			if (failed.length > 0) {
				const first = failed[0] as PromiseRejectedResult;
				const message =
					first.reason instanceof Error
						? first.reason.message
						: "部分文件上传失败";
				setError(message);
				toast.error(message);
			}
			await loadLibraries();
			await loadDocuments(selectedId);
		} catch (err) {
			setLastUploadMs(Math.round(performance.now() - started));
			const message = err instanceof Error ? err.message : "上传失败";
			setError(message);
			toast.error(message);
		} finally {
			setUploading(false);
			if (fileInputRef.current) fileInputRef.current.value = "";
		}
	}

	function openCreateLibraryDialog() {
		setEditingLibrary(null);
		setLibraryName("");
		setLibraryDescription("");
		setLibraryDocumentProfile("auto");
		setLibraryScanHandling("auto");
		setLibraryAdvancedOpen(false);
		setLibraryFormError(null);
		setLibraryDialogMode("create");
		setLibraryDialogOpen(true);
	}

	function openEditLibraryDialog(library: ApiLibrary) {
		setEditingLibrary(library);
		setLibraryName(library.name);
		setLibraryDescription(library.description?.trim() ?? "");
		setLibraryDocumentProfile(library.document_profile ?? "auto");
		setLibraryScanHandling(library.scan_handling ?? "auto");
		setLibraryAdvancedOpen((library.scan_handling ?? "auto") !== "auto");
		setLibraryFormError(null);
		setLibraryDialogMode("edit");
		setLibraryDialogOpen(true);
	}

	function closeLibraryDialog() {
		if (savingLibrary || deletingLibrary) return;
		// 仅关闭；保留 mode / 表单，避免关闭动画期间标题闪成「新建」
		setLibraryDialogOpen(false);
		setLibraryFormError(null);
	}

	async function onSubmitLibraryForm() {
		const name = libraryName.trim();
		if (!name) {
			setLibraryFormError("请填写知识库名称");
			return;
		}
		setSavingLibrary(true);
		setLibraryFormError(null);
		setError(null);
		try {
			const description = libraryDescription.trim() || undefined;
			if (libraryDialogMode === "create") {
				const created = await createLibrary({
					name,
					description,
					documentProfile: libraryDocumentProfile,
					scanHandling: libraryScanHandling,
				});
				toast.success(`已创建知识库「${created.name}」`);
				setLibraryDialogOpen(false);
				await loadLibraries();
				setSelectedId(created.id);
			} else if (libraryDialogMode === "edit" && editingLibrary) {
				const updated = await updateLibrary({
					libraryId: editingLibrary.id,
					name,
					description: description ?? null,
					documentProfile: libraryDocumentProfile,
					scanHandling: libraryScanHandling,
				});
				if (updated.requires_reindex) {
					toast.success(
						`已更新「${updated.name}」。文档处理预设已变更，需重新索引后才会全部生效。`,
					);
				} else {
					toast.success(`已更新知识库「${updated.name}」`);
				}
				setLibraryDialogOpen(false);
				await loadLibraries();
			}
		} catch (err) {
			const message =
				err instanceof Error
					? err.message
					: libraryDialogMode === "create"
						? "创建失败"
						: "更新失败";
			setLibraryFormError(message);
			toast.error(message);
		} finally {
			setSavingLibrary(false);
		}
	}

	async function onConfirmDeleteLibrary() {
		if (!deleteLibraryTarget) return;
		const target = deleteLibraryTarget;
		setDeletingLibrary(true);
		setError(null);
		setLibraryFormError(null);
		try {
			const nextSelectedId =
				selectedId === target.id
					? (() => {
							const idx = libraries.findIndex((item) => item.id === target.id);
							if (idx < 0) return "";
							return libraries[idx + 1]?.id ?? libraries[idx - 1]?.id ?? "";
						})()
					: selectedId;
			const result = await deleteLibrary(target.id);
			toast.success(
				result.accepted
					? `已排队删除知识库「${target.name}」（${result.deleted_documents} 篇文档）`
					: `已删除知识库「${target.name}」`,
			);
			setDeleteLibraryTarget(null);
			setLibraryDialogOpen(false);
			setDetailDocId(null);
			setDeleteDocId(null);
			if (selectedId === target.id) {
				setSelectedId(nextSelectedId);
				setDocuments([]);
			}
			await loadLibraries();
		} catch (err) {
			const message = err instanceof Error ? err.message : "删除知识库失败";
			setError(message);
			toast.error(message);
			setDeleteLibraryTarget(null);
		} finally {
			setDeletingLibrary(false);
		}
	}

	async function onReindex(doc: ApiDocument) {
		if (!doc.has_file) {
			const message = "原文未保留，请重新上传后再重索引";
			setError(message);
			toast.error(message);
			return;
		}
		if (doc.status === "processing") return;
		setBusyDocId(doc.id);
		setError(null);
		try {
			if (!selectedId) {
				throw new Error("请先选择知识库");
			}
			const result = await reindexDocument({
				libraryId: selectedId,
				docId: doc.id,
			});
			if (result.accepted || result.status === "processing") {
				trackProcessing([{ id: result.doc_id, name: result.title }]);
				toast.success(`已提交重索引「${result.title}」`);
			} else {
				toast.success(
					`已重索引「${result.title}」· ${result.chunk_count} chunks`,
				);
			}
			await loadLibraries();
			if (selectedId) await loadDocuments(selectedId);
		} catch (err) {
			const message = err instanceof Error ? err.message : "重索引失败";
			setError(message);
			toast.error(message);
			if (selectedId) await loadDocuments(selectedId);
		} finally {
			setBusyDocId(null);
		}
	}

	async function onCancelJob(doc: ApiDocument) {
		if (!doc.job_id) return;
		setBusyDocId(doc.id);
		setError(null);
		try {
			const result = await cancelJob(doc.job_id);
			toast.success(
				result.status === "cancelling" ? "已请求取消任务" : "任务已取消",
			);
			await loadLibraries();
			if (selectedId) await loadDocuments(selectedId);
		} catch (err) {
			const message = err instanceof Error ? err.message : "取消任务失败";
			setError(message);
			toast.error(message);
		} finally {
			setBusyDocId(null);
		}
	}

	async function onRetryJob(doc: ApiDocument) {
		if (!doc.job_id) return;
		setBusyDocId(doc.id);
		setError(null);
		try {
			const result = await retryJob(doc.job_id);
			trackProcessing([{ id: result.document_id, name: doc.name }]);
			toast.success(`已重新提交「${doc.name}」`);
			await loadLibraries();
			if (selectedId) await loadDocuments(selectedId);
		} catch (err) {
			const message = err instanceof Error ? err.message : "重试任务失败";
			setError(message);
			toast.error(message);
		} finally {
			setBusyDocId(null);
		}
	}

	async function onDownload(doc: ApiDocument) {
		if (!doc.has_file) {
			const message = "原文未保留，请重新上传后再下载";
			setError(message);
			toast.error(message);
			return;
		}
		setBusyDocId(doc.id);
		setError(null);
		try {
			await downloadDocument(doc.id, doc.filename);
			toast.success(`已开始下载「${doc.filename}」`);
		} catch (err) {
			const message = err instanceof Error ? err.message : "下载失败";
			setError(message);
			toast.error(message);
		} finally {
			setBusyDocId(null);
		}
	}

	async function onConfirmDelete() {
		if (!deleteDocId || !selectedId) return;
		const id = deleteDocId;
		setBusyDocId(id);
		setError(null);
		try {
			await deleteDocument({ libraryId: selectedId, docId: id });
			toast.success("已排队删除文档（后台清理向量、对象与元数据）");
			if (detailDocId === id) setDetailDocId(null);
			setDeleteDocId(null);
			await loadLibraries();
			if (selectedId) await loadDocuments(selectedId);
		} catch (err) {
			const message = err instanceof Error ? err.message : "删除失败";
			setError(message);
			toast.error(message);
		} finally {
			setBusyDocId(null);
		}
	}

	function startReplace(doc: ApiDocument) {
		if (doc.status === "processing") return;
		setReplaceDoc(doc);
		setReplaceFile(null);
		replaceInputRef.current?.click();
	}

	function onReplaceFilePicked(files: FileList | null) {
		const file = files?.[0] ?? null;
		if (replaceInputRef.current) replaceInputRef.current.value = "";
		if (!file || !replaceDoc) {
			setReplaceDoc(null);
			return;
		}
		setReplaceFile(file);
	}

	function cancelReplace() {
		if (replacing) return;
		setReplaceDoc(null);
		setReplaceFile(null);
	}

	async function onConfirmReplace() {
		if (!replaceDoc || !replaceFile || !selectedId) return;
		const doc = replaceDoc;
		const file = replaceFile;
		setReplacing(true);
		setBusyDocId(doc.id);
		setError(null);
		try {
			const result = await replaceDocument({
				libraryId: selectedId,
				docId: doc.id,
				file,
			});
			if (result.accepted || result.status === "processing") {
				trackProcessing([{ id: result.doc_id, name: result.title }]);
				toast.success(`已提交替换「${result.title}」，正在重新索引`);
			} else {
				toast.success(
					`已替换「${result.title}」· ${result.chunk_count} chunks`,
				);
			}
			setReplaceDoc(null);
			setReplaceFile(null);
			await loadLibraries();
			if (selectedId) await loadDocuments(selectedId);
		} catch (err) {
			const message = err instanceof Error ? err.message : "替换失败";
			setError(message);
			toast.error(message);
		} finally {
			setReplacing(false);
			setBusyDocId(null);
		}
	}

	const uploadDisabled = uploading || !selectedId;
	const detailActions = filterByCap(
		caps,
		buildDetailActions({
			onAcl: (doc) => setAclDoc(doc),
			onReplace: startReplace,
			onReindex: (doc) => {
				void onReindex(doc);
			},
			onDownload: (doc) => {
				void onDownload(doc);
			},
			onDelete: (doc) => setDeleteDocId(doc.id),
		}),
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex min-h-0 flex-1 flex-col md:flex-row">
				{/* 左栏：知识库列表 */}
				<aside className="flex h-[min(42vh,22rem)] w-full shrink-0 flex-col border-b border-border/80 bg-card/40 md:h-auto md:w-65 md:border-r md:border-b-0">
					<div className="space-y-1 border-b border-border/70 px-4 py-4">
						<p className="text-meta font-mono tracking-[0.2em] text-cite uppercase">
							Libraries
						</p>
						<h2 className="font-heading text-lg font-semibold tracking-tight">
							知识库
						</h2>
						<p className="text-meta text-muted-foreground">
							{libraries.length} 个库 ·{" "}
							{libraries.reduce((sum, item) => sum + (item.doc_count || 0), 0)}{" "}
							文档
						</p>
					</div>
					<ScrollArea className="min-h-0 flex-1">
						<ul className="flex flex-col gap-0.5 p-2">
							{libraries.length === 0 && !loading ? (
								<li className="px-2 py-6 text-center text-ui text-muted-foreground">
									还没有知识库
								</li>
							) : null}
							{libraries.map((library) => (
								<li key={library.id}>
									<button
										type="button"
										onClick={() => {
											setSelectedId(library.id);
											setDetailDocId(null);
										}}
										className={cn(
											"flex w-full items-start gap-2.5 rounded-md px-2.5 py-2.5 text-left transition-colors",
											selectedId === library.id
												? "bg-cite/10 text-foreground"
												: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
										)}
									>
										<LibStatusDot status={library.status} />
										<span className="min-w-0 flex-1">
											<span className="block truncate text-[0.9375rem] font-medium text-foreground">
												{library.name}
											</span>
											{library.description?.trim() ? (
												<span className="text-meta mt-0.5 block truncate text-muted-foreground">
													{library.description.trim()}
												</span>
											) : null}
											<span className="text-meta mt-0.5 block font-mono text-muted-foreground">
												{library.status === "indexing"
													? `${library.ready_count}/${library.doc_count} 索引中`
													: library.status === "empty"
														? "空库"
														: `${library.ready_count}/${library.doc_count} 就绪`}
											</span>
										</span>
									</button>
								</li>
							))}
						</ul>
					</ScrollArea>
					<Can cap="manageLibraries">
						<div className="border-t border-border/70 p-3">
							<Button
								type="button"
								variant="outline"
								className="w-full rounded-md"
								disabled={savingLibrary}
								onClick={openCreateLibraryDialog}
							>
								<Plus data-icon="inline-start" />
								新建知识库
							</Button>
						</div>
					</Can>
				</aside>

				{/* 右栏：文档表 */}
				<section className="flex min-w-0 flex-1 flex-col">
					<div className="flex flex-wrap items-end justify-between gap-3 border-b border-border/70 px-5 py-4">
						<div className="min-w-0 space-y-1">
							<h3 className="font-heading truncate text-xl font-semibold tracking-tight">
								{selectedLibrary?.name ?? "选择知识库"}
							</h3>
							{selectedLibrary?.description?.trim() ? (
								<p className="text-ui truncate text-muted-foreground">
									{selectedLibrary.description.trim()}
								</p>
							) : null}
							<p className="text-ui text-muted-foreground">
								{selectedLibrary
									? canWriteLibraries
										? "上传 txt / md / docx / pdf。点行查看详情；支持重索引、下载与删除。"
										: "点行查看详情与下载。当前角色为只读，无法上传或删除。"
									: canManageLibraries
										? "从左侧选择或新建知识库。"
										: "从左侧选择知识库。"}
							</p>
						</div>
						<div className="flex flex-wrap items-end gap-2">
							<Can cap="writeLibraries">
								<input
									ref={fileInputRef}
									type="file"
									accept=".txt,.md,.markdown,.docx,.pdf,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
									className="hidden"
									multiple
									onChange={(event) => void onUploadFiles(event.target.files)}
								/>
								<input
									ref={replaceInputRef}
									type="file"
									accept=".txt,.md,.markdown,.docx,.pdf,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
									className="hidden"
									onChange={(event) => onReplaceFilePicked(event.target.files)}
								/>
							</Can>
							<Button
								type="button"
								variant="outline"
								className="rounded-md"
								disabled={loading || !selectedId}
								onClick={() => {
									void loadLibraries();
									if (selectedId) void loadDocuments(selectedId);
								}}
							>
								<RefreshCw data-icon="inline-start" />
								刷新
							</Button>
							<AuthButton
								cap="writeLibraries"
								type="button"
								className="rounded-md"
								disabled={uploadDisabled}
								onClick={() => fileInputRef.current?.click()}
							>
								<FileUp data-icon="inline-start" />
								{uploading ? "上传中…" : "上传"}
							</AuthButton>
							<AuthButton
								cap="manageLibraries"
								type="button"
								variant="outline"
								className="rounded-md"
								disabled={!selectedLibrary || savingLibrary || deletingLibrary}
								onClick={() => {
									if (selectedLibrary) openEditLibraryDialog(selectedLibrary);
								}}
							>
								<Pencil data-icon="inline-start" />
								编辑
							</AuthButton>
							<AuthButton
								cap="manageLibraries"
								type="button"
								variant="outline"
								className="rounded-md"
								disabled={!selectedLibrary || savingLibrary || deletingLibrary}
								onClick={() => {
									if (selectedLibrary) setDeleteLibraryTarget(selectedLibrary);
								}}
							>
								<Trash2 data-icon="inline-start" />
								删除
							</AuthButton>
							{selectedLibrary ? (
								<Link
									href="/app/ask"
									className={cn(
										buttonVariants({ variant: "outline" }),
										"rounded-md",
									)}
								>
									去问答
								</Link>
							) : null}
						</div>
					</div>

					{(error || librariesError) && (
						<p className="text-ui mx-5 mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive">
							{error || librariesError}
						</p>
					)}

					{lastUploadMs != null ? (
						<p className="text-meta mx-5 mt-2 font-mono text-muted-foreground">
							上次上传 {formatDurationMs(lastUploadMs)}
						</p>
					) : null}

					<div className="min-h-0 flex-1 px-5 py-4">
						{!selectedId ? (
							<div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border/80 bg-muted/20 px-6 text-center">
								<p className="text-ui text-muted-foreground">
									{canManageLibraries
										? "请先创建或选择一个知识库"
										: "请从左侧选择一个知识库"}
								</p>
								<AuthButton
									cap="manageLibraries"
									type="button"
									className="rounded-md"
									disabled={savingLibrary}
									onClick={openCreateLibraryDialog}
								>
									<Plus data-icon="inline-start" />
									新建知识库
								</AuthButton>
							</div>
						) : documents.length === 0 ? (
							<div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border/80 bg-muted/20 px-6 text-center">
								<p className="text-ui text-muted-foreground">
									{canWriteLibraries
										? "尚无文档。上传后即可在问答中引用。"
										: "尚无文档。当前角色为只读，请联系编辑者或管理员上传。"}
								</p>
								<AuthButton
									cap="writeLibraries"
									type="button"
									className="rounded-md"
									disabled={uploadDisabled}
									onClick={() => fileInputRef.current?.click()}
								>
									<FileUp data-icon="inline-start" />
									上传文档
								</AuthButton>
							</div>
						) : (
							<div className="overflow-x-auto rounded-md border border-border/80">
								<Table>
									<TableHeader>
										<TableRow className="hover:bg-transparent">
											<TableHead>显示名</TableHead>
											<TableHead>原文件</TableHead>
											<TableHead>状态</TableHead>
											<TableHead className="text-right">大小</TableHead>
											<TableHead className="text-right">Chunks</TableHead>
											<TableHead>更新时间</TableHead>
											<TableHead className="w-12 text-right">操作</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{documents.map((doc) => {
											const busy = busyDocId === doc.id;
											const processing = doc.status === "processing";
											const actionCtx: DocActionContext = {
												busy,
												processing,
												onView: (item) => setDetailDocId(item.id),
												onAcl: (item) => setAclDoc(item),
												onReplace: startReplace,
												onReindex: (item) => {
													void onReindex(item);
												},
												onCancelJob: (item) => {
													void onCancelJob(item);
												},
												onRetryJob: (item) => {
													void onRetryJob(item);
												},
												onDownload: (item) => {
													void onDownload(item);
												},
												onDelete: (item) => setDeleteDocId(item.id),
											};
											const actions = resolveDocActions(caps, doc);
											return (
												<TableRow
													key={doc.id}
													className="cursor-pointer"
													onClick={() => setDetailDocId(doc.id)}
												>
													<TableCell className="max-w-50">
														<span className="block truncate font-medium">
															{doc.name}
														</span>
													</TableCell>
													<TableCell className="max-w-40">
														<span className="text-meta block truncate font-mono text-muted-foreground">
															{doc.filename}
														</span>
													</TableCell>
													<TableCell>
														<DocStatusBadge
															status={doc.status}
															parserReport={doc.parser_report}
														/>
														{doc.job_stage &&
														doc.job_status &&
														!TERMINAL_JOB_STATUSES.has(doc.job_status) ? (
															<span className="text-meta mt-1 block font-mono text-muted-foreground">
																{doc.job_stage}
																{doc.job_progress != null
																	? ` · ${doc.job_progress}%`
																	: ""}
															</span>
														) : null}
													</TableCell>
													<TableCell className="text-right font-mono text-meta text-muted-foreground">
														{formatFileSize(doc.size_bytes)}
													</TableCell>
													<TableCell className="text-right font-mono text-meta">
														{doc.chunk_count}
													</TableCell>
													<TableCell className="text-meta font-mono text-muted-foreground">
														{formatDateTime(doc.updated_at)}
													</TableCell>
													<TableCell
														className="text-right"
														onClick={(event) => event.stopPropagation()}
													>
														<DropdownMenu>
															<DropdownMenuTrigger
																render={
																	<Button
																		variant="ghost"
																		size="icon-sm"
																		className="rounded-md"
																		disabled={busy}
																	/>
																}
															>
																<MoreHorizontal />
																<span className="sr-only">操作</span>
															</DropdownMenuTrigger>
															<DropdownMenuContent
																align="end"
																className="min-w-40"
															>
																{actions.map((action) => {
																	const Icon = action.icon;
																	return (
																		<div key={action.id}>
																			{action.separatorBefore ? (
																				<DropdownMenuSeparator />
																			) : null}
																			<DropdownMenuItem
																				variant={
																					action.destructive
																						? "destructive"
																						: undefined
																				}
																				disabled={
																					action.disabled?.(doc, actionCtx) ??
																					false
																				}
																				onClick={() =>
																					action.run(doc, actionCtx)
																				}
																			>
																				<Icon />
																				{action.label}
																			</DropdownMenuItem>
																		</div>
																	);
																})}
															</DropdownMenuContent>
														</DropdownMenu>
													</TableCell>
												</TableRow>
											);
										})}
									</TableBody>
								</Table>
							</div>
						)}
					</div>
				</section>
			</div>

			{/* 详情 Sheet */}
			<Sheet
				open={detailDocId != null && detailDoc != null}
				onOpenChange={(open) => {
					if (!open) setDetailDocId(null);
				}}
			>
				<SheetContent
					side="right"
					className="w-full sm:max-w-md"
					showCloseButton
				>
					{detailDoc ? (
						<>
							<SheetHeader className="border-b border-border/70">
								<SheetTitle className="pr-8">{detailDoc.name}</SheetTitle>
								<SheetDescription>
									{detailDoc.filename} · {detailDoc.content_type || "未知类型"}
								</SheetDescription>
							</SheetHeader>
							<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-2">
								<div className="flex flex-wrap items-center gap-2">
									<DocStatusBadge
										status={detailDoc.status}
										parserReport={detailDoc.parser_report}
									/>
									<span className="text-meta font-mono text-muted-foreground">
										{detailDoc.chunk_count} chunks
									</span>
									<span className="text-meta font-mono text-muted-foreground">
										{formatFileSize(detailDoc.size_bytes)}
									</span>
									{detailDoc.has_file ? (
										<span className="text-meta rounded-md border border-cite/30 bg-cite/10 px-2 py-0.5 font-mono text-cite">
											原文已保留
										</span>
									) : (
										<span className="text-meta rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-muted-foreground">
											原文未保留
										</span>
									)}
								</div>

								<dl className="grid gap-3 text-ui">
									<div>
										<dt className="text-meta font-mono text-muted-foreground uppercase tracking-wide">
											大小
										</dt>
										<dd className="mt-0.5 font-mono text-meta">
											{formatFileSize(detailDoc.size_bytes)}
										</dd>
									</div>
									<div>
										<dt className="text-meta font-mono text-muted-foreground uppercase tracking-wide">
											创建
										</dt>
										<dd className="mt-0.5 font-mono text-meta">
											{formatDateTime(detailDoc.created_at)}
										</dd>
									</div>
									<div>
										<dt className="text-meta font-mono text-muted-foreground uppercase tracking-wide">
											更新
										</dt>
										<dd className="mt-0.5 font-mono text-meta">
											{formatDateTime(detailDoc.updated_at)}
										</dd>
									</div>
									{typeof detailDoc.parser_report?.parser === "string" ? (
										<div>
											<dt className="text-meta font-mono text-muted-foreground uppercase tracking-wide">
												解析器
											</dt>
											<dd className="mt-0.5 font-mono text-meta">
												{detailDoc.parser_report.parser}
											</dd>
										</div>
									) : null}
								</dl>

								{detailDoc.error ? (
									<div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
										<p className="text-meta font-mono uppercase tracking-wide text-destructive">
											错误
										</p>
										<p className="text-ui mt-1 text-destructive">
											{detailDoc.error}
										</p>
									</div>
								) : null}

								<div className="rounded-md border border-border/80 bg-muted/20 px-3 py-2">
									<p className="text-meta font-mono uppercase tracking-wide text-muted-foreground">
										版本历史
									</p>
									{versionsLoading ? (
										<p className="text-ui mt-2 text-muted-foreground">
											加载中…
										</p>
									) : versionRows.length === 0 ? (
										<p className="text-ui mt-2 text-muted-foreground">
											暂无版本
										</p>
									) : (
										<ul className="mt-2 space-y-2">
											{versionRows.map((version) => (
												<li
													key={version.id}
													className="flex items-start justify-between gap-2 border-t border-border/50 pt-2 first:border-t-0 first:pt-0"
												>
													<div className="min-w-0">
														<p className="font-mono text-meta">
															v{version.version}
															{version.is_active ? " · active" : ""}
															{version.is_desired && !version.is_active
																? " · desired"
																: ""}
														</p>
														<p className="truncate text-meta text-muted-foreground">
															{version.generation_id.slice(0, 8)}…
															{version.chunk_count != null
																? ` · ${version.chunk_count} chunks`
																: ""}
														</p>
													</div>
													<DocStatusBadge status={version.status} />
												</li>
											))}
										</ul>
									)}
								</div>

								{detailDoc.parser_report ? (
									<ParserReportCard report={detailDoc.parser_report} />
								) : null}

								{!detailDoc.has_file ? (
									<p className="text-ui text-muted-foreground">
										此文档上传时未落盘原文，无法下载或重索引。
										{canWriteLibraries ? "可用「替换文件」重新上传。" : ""}
									</p>
								) : null}
							</div>
							<SheetFooter className="border-t border-border/70">
								<div className="flex flex-wrap gap-2">
									{detailActions.map((action) => {
										const Icon = action.icon;
										const busy = busyDocId === detailDoc.id;
										const highlightReindex =
											action.id === "reindex" &&
											isParserReportDegraded(detailDoc.parser_report) &&
											Boolean(detailDoc.has_file);
										return (
											<AuthButton
												key={action.id}
												cap={action.cap}
												type="button"
												variant={
													highlightReindex
														? "default"
														: (action.variant ?? "outline")
												}
												className="rounded-md"
												disabled={action.disabled?.(detailDoc, busy) ?? false}
												onClick={() => action.run(detailDoc)}
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

			<DocumentAclDialog
				open={aclDoc != null}
				libraryId={selectedId || null}
				doc={aclDoc}
				onOpenChange={(next) => {
					if (!next) setAclDoc(null);
				}}
				onProjected={(item) => {
					trackProcessing([{ id: item.id, name: item.name }]);
					void loadLibraries();
					if (selectedId) void loadDocuments(selectedId);
				}}
			/>

			{/* 删除确认 */}
			<AlertDialog
				open={deleteDocId != null}
				onOpenChange={(open) => {
					if (!open) setDeleteDocId(null);
				}}
			>
				<AlertDialogContent size="default">
					<AlertDialogHeader>
						<AlertDialogTitle>删除文档？</AlertDialogTitle>
						<AlertDialogDescription>
							将清除「{deleteDoc?.name ?? "该文档"}」的向量与元数据
							{deleteDoc?.has_file ? "及已落盘原文" : ""}
							，此操作不可恢复。
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busyDocId === deleteDocId}>
							取消
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={busyDocId === deleteDocId}
							onClick={(event) => {
								event.preventDefault();
								void onConfirmDelete();
							}}
						>
							{busyDocId === deleteDocId ? "删除中…" : "确认删除"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			{/* 替换文件确认 */}
			<AlertDialog
				open={replaceDoc != null && replaceFile != null}
				onOpenChange={(open) => {
					if (!open) cancelReplace();
				}}
			>
				<AlertDialogContent size="default">
					<AlertDialogHeader>
						<AlertDialogTitle>替换文件？</AlertDialogTitle>
						<AlertDialogDescription>
							将用「{replaceFile?.name}」覆盖「{replaceDoc?.name}
							」：清除旧向量与原文后按新文件重新索引，文档 ID
							不变。此操作不可恢复旧版内容。
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={replacing} onClick={cancelReplace}>
							取消
						</AlertDialogCancel>
						<AlertDialogAction
							disabled={replacing}
							onClick={(event) => {
								event.preventDefault();
								void onConfirmReplace();
							}}
						>
							{replacing ? "替换中…" : "确认替换"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			{/* 新建 / 编辑知识库 */}
			<Dialog
				open={libraryDialogOpen}
				onOpenChange={(open) => {
					if (!open) closeLibraryDialog();
				}}
			>
				<DialogContent
					className="sm:max-w-md"
					showCloseButton={!savingLibrary && !deletingLibrary}
				>
					<DialogHeader>
						<DialogTitle>
							{libraryDialogMode === "edit" ? "编辑知识库" : "新建知识库"}
						</DialogTitle>
						<DialogDescription>
							{libraryDialogMode === "edit"
								? "修改名称、描述与文档处理预设；更改预设不会自动全量重建。"
								: "填写名称即可创建；可选择文档处理预设。"}
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-3">
						<div className="grid gap-1.5">
							<Label htmlFor="library-name">名称</Label>
							<Input
								id="library-name"
								value={libraryName}
								onChange={(event) => {
									setLibraryName(event.target.value);
									if (libraryFormError) setLibraryFormError(null);
								}}
								placeholder="例如：人事制度库"
								maxLength={256}
								disabled={savingLibrary || deletingLibrary}
								autoFocus
								aria-invalid={Boolean(libraryFormError && !libraryName.trim())}
							/>
						</div>
						<div className="grid gap-1.5">
							<Label htmlFor="library-description">描述（可选）</Label>
							<Textarea
								id="library-description"
								value={libraryDescription}
								onChange={(event) => setLibraryDescription(event.target.value)}
								placeholder="简要说明此知识库的用途"
								maxLength={2000}
								disabled={savingLibrary || deletingLibrary}
								className="min-h-20"
							/>
						</div>
						<div className="grid gap-1.5">
							<Label htmlFor="library-document-profile">文档处理预设</Label>
							<select
								id="library-document-profile"
								className="rounded-md border border-border bg-background px-2 py-2 text-sm"
								value={libraryDocumentProfile}
								disabled={savingLibrary || deletingLibrary}
								onChange={(event) =>
									setLibraryDocumentProfile(event.target.value)
								}
							>
								<option value="auto">自动</option>
								<option value="general">通用</option>
								<option value="narrative">叙述/长文</option>
								<option value="table_heavy">表格密集</option>
								<option value="regulatory">制度/规章</option>
								<option value="precise_paragraph">精确段落</option>
							</select>
							{libraryDialogMode === "edit" &&
							editingLibrary?.requires_reindex ? (
								<p className="text-xs text-muted-foreground">
									当前库已有文档，且预设与已索引内容不一致；保存后不会自动全量重建，请按需对文档重新索引。
								</p>
							) : libraryDialogMode === "edit" &&
								editingLibrary &&
								libraryDocumentProfile !==
									(editingLibrary.document_profile ?? "auto") &&
								(editingLibrary.doc_count ?? 0) > 0 ? (
								<p className="text-xs text-amber-700 dark:text-amber-400">
									更改预设不会自动重新索引已有文档；新上传/手动重索引将使用新预设。
								</p>
							) : null}
						</div>
						<div className="grid gap-1.5">
							<button
								type="button"
								className="text-left text-xs text-muted-foreground underline-offset-2 hover:underline"
								onClick={() => setLibraryAdvancedOpen((open) => !open)}
							>
								{libraryAdvancedOpen ? "收起高级选项" : "高级选项（OCR）"}
							</button>
							{libraryAdvancedOpen ? (
								<div className="grid gap-1.5 rounded-md border border-border/70 px-3 py-2">
									<Label htmlFor="library-scan-handling">扫描件处理</Label>
									<select
										id="library-scan-handling"
										className="rounded-md border border-border bg-background px-2 py-2 text-sm"
										value={libraryScanHandling}
										disabled={savingLibrary || deletingLibrary}
										onChange={(event) =>
											setLibraryScanHandling(event.target.value)
										}
									>
										<option value="auto">自动</option>
										<option value="disabled">仅文本解析（禁用扫描识别）</option>
										<option value="force_ocr">强制 OCR</option>
									</select>
									<p className="text-xs text-muted-foreground">
										对新上传/重索引生效：自动沿用部署默认；仅文本解析不会调用
										OCR 或 MinerU，纯扫描文件会明确失败；强制 OCR
										会覆盖部署默认，但不强制数字 PDF 全文 OCR。更改后需重索引。
									</p>
								</div>
							) : null}
						</div>
						{libraryFormError ? (
							<p className="text-ui rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive">
								{libraryFormError}
							</p>
						) : null}
					</div>
					<DialogFooter
						className={
							libraryDialogMode === "edit" ? "sm:justify-between" : undefined
						}
					>
						{libraryDialogMode === "edit" && editingLibrary ? (
							<Button
								type="button"
								variant="destructive"
								className="rounded-md sm:mr-auto"
								disabled={savingLibrary || deletingLibrary}
								onClick={() => setDeleteLibraryTarget(editingLibrary)}
							>
								<Trash2 data-icon="inline-start" />
								删除
							</Button>
						) : null}
						<Button
							type="button"
							variant="outline"
							className="rounded-md"
							disabled={savingLibrary || deletingLibrary}
							onClick={closeLibraryDialog}
						>
							取消
						</Button>
						<Button
							type="button"
							className="rounded-md"
							disabled={savingLibrary || deletingLibrary}
							onClick={() => void onSubmitLibraryForm()}
						>
							{savingLibrary
								? libraryDialogMode === "edit"
									? "保存中…"
									: "创建中…"
								: libraryDialogMode === "edit"
									? "保存"
									: "创建"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* 删除知识库确认 */}
			<AlertDialog
				open={deleteLibraryTarget != null}
				onOpenChange={(open) => {
					if (!open && !deletingLibrary) setDeleteLibraryTarget(null);
				}}
			>
				<AlertDialogContent size="default">
					<AlertDialogHeader>
						<AlertDialogTitle>删除知识库？</AlertDialogTitle>
						<AlertDialogDescription>
							将清除「{deleteLibraryTarget?.name ?? "该知识库"}
							」下所有文档的向量、元数据与原文，此操作不可恢复。
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={deletingLibrary}>
							取消
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={deletingLibrary}
							onClick={(event) => {
								event.preventDefault();
								void onConfirmDeleteLibrary();
							}}
						>
							{deletingLibrary ? "删除中…" : "确认删除"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
