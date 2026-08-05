"use client";

import {
	FileUp,
	MessageSquareText,
	MoreHorizontal,
	Pencil,
	Plus,
	RefreshCw,
	Search,
	Settings2,
	Trash2,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AuthButton } from "@/components/app/auth-button";
import { Can, useCan } from "@/components/app/can";
import { DocumentAclDialog } from "@/components/app/document-acl-dialog";
import { DocumentDetailSheet } from "@/components/app/document-detail-sheet";
import { DocumentStatusBadge } from "@/components/app/document-status";
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
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useDocumentVersions } from "@/hooks/use-document-versions";
import { useDocuments } from "@/hooks/use-documents";
import { useLibraries } from "@/hooks/use-libraries";
import {
	type ApiDocument,
	type ApiLibrary,
	cancelJob,
	createLibrary,
	deleteDocument,
	deleteLibrary,
	downloadDocument,
	reindexDocument,
	replaceDocument,
	retryJob,
	updateLibrary,
	uploadDocument,
} from "@/lib/api";
import {
	ASK_LIBRARY_STORAGE_KEY,
	isAskableLibrary,
} from "@/lib/ask-library-selection.mjs";
import { filterByCap } from "@/lib/client-permissions";
import { TERMINAL_JOB_STATUSES } from "@/lib/document-lifecycle-contract";
import { formatDateTime, formatDurationMs, formatFileSize } from "@/lib/format";
import { cn } from "@/lib/utils";

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

type DocumentOverlay =
	| { kind: "none" }
	| { kind: "detail"; docId: string }
	| { kind: "delete"; docId: string }
	| { kind: "acl"; doc: ApiDocument }
	| { kind: "replace"; doc: ApiDocument; file: File | null };

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
	const [documentQuery, setDocumentQuery] = useState("");
	const [uploading, setUploading] = useState(false);
	const [savingLibrary, setSavingLibrary] = useState(false);
	const [busyDocId, setBusyDocId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [lastUploadMs, setLastUploadMs] = useState<number | null>(null);
	const [documentOverlay, setDocumentOverlay] = useState<DocumentOverlay>({
		kind: "none",
	});
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
	const [libraryParsePreference, setLibraryParsePreference] = useState("auto");
	const [libraryAdvancedOpen, setLibraryAdvancedOpen] = useState(false);
	const [libraryFormError, setLibraryFormError] = useState<string | null>(null);
	const [deleteLibraryTarget, setDeleteLibraryTarget] =
		useState<ApiLibrary | null>(null);
	const [deletingLibrary, setDeletingLibrary] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const replaceInputRef = useRef<HTMLInputElement>(null);
	const detailDocId =
		documentOverlay.kind === "detail" ? documentOverlay.docId : null;
	const deleteDocId =
		documentOverlay.kind === "delete" ? documentOverlay.docId : null;
	const aclDoc = documentOverlay.kind === "acl" ? documentOverlay.doc : null;
	const replaceDoc =
		documentOverlay.kind === "replace" ? documentOverlay.doc : null;
	const replaceFile =
		documentOverlay.kind === "replace" ? documentOverlay.file : null;
	const selectedLibraryExists = libraries.some(
		(item) => item.id === selectedId,
	);
	const {
		documents,
		error: documentsError,
		refresh: refreshDocuments,
	} = useDocuments(selectedId, { enabled: selectedLibraryExists });
	const pageError =
		error ||
		librariesError ||
		(documentsError && !/404|not found/i.test(documentsError)
			? `文档列表加载失败：${documentsError}`
			: null);
	const {
		versions: versionRows,
		loading: versionsLoading,
		refresh: refreshVersions,
	} = useDocumentVersions(selectedId, detailDocId ?? "");

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

	const filteredDocuments = useMemo(() => {
		const query = documentQuery.trim().toLocaleLowerCase();
		if (!query) return documents;
		return documents.filter((doc) =>
			`${doc.name} ${doc.filename}`.toLocaleLowerCase().includes(query),
		);
	}, [documents, documentQuery]);

	const documentSummary = useMemo(
		() => ({
			ready: documents.filter((doc) => doc.status === "ready").length,
			processing: documents.filter((doc) =>
				["processing", "indexing", "queued"].includes(doc.status),
			).length,
			failed: documents.filter((doc) => doc.status === "failed").length,
			chunks: documents.reduce(
				(sum, doc) => sum + Math.max(0, doc.chunk_count || 0),
				0,
			),
		}),
		[documents],
	);

	useEffect(() => {
		if (libraries.length === 0) {
			if (selectedId) setSelectedId("");
			setDocumentQuery("");
			return;
		}
		const stillExists = libraries.some((item) => item.id === selectedId);
		if (!selectedId || !stillExists) {
			setSelectedId(libraries[0].id);
			setDocumentQuery("");
		}
	}, [libraries, selectedId]);

	useEffect(() => {
		if (!detailDocId || !selectedId || ingestTick === 0) return;
		void refreshVersions();
	}, [detailDocId, selectedId, ingestTick, refreshVersions]);

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
			await refreshDocuments();
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
		setLibraryParsePreference("auto");
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
		setLibraryParsePreference(library.parse_preference ?? "auto");
		setLibraryAdvancedOpen(
			(library.scan_handling ?? "auto") !== "auto" ||
				(library.parse_preference ?? "auto") !== "auto",
		);
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
					parsePreference: libraryParsePreference,
				});
				toast.success(`已创建知识库「${created.name}」`);
				setLibraryDialogOpen(false);
				await loadLibraries();
				setSelectedId(created.id);
				setDocumentQuery("");
			} else if (libraryDialogMode === "edit" && editingLibrary) {
				const updated = await updateLibrary({
					libraryId: editingLibrary.id,
					name,
					description: description ?? null,
					documentProfile: libraryDocumentProfile,
					scanHandling: libraryScanHandling,
					parsePreference: libraryParsePreference,
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
			setDocumentOverlay({ kind: "none" });
			if (selectedId === target.id) {
				setSelectedId(nextSelectedId);
				setDocumentQuery("");
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
			if (selectedId) await refreshDocuments();
		} catch (err) {
			const message = err instanceof Error ? err.message : "重索引失败";
			setError(message);
			toast.error(message);
			if (selectedId) await refreshDocuments();
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
			if (selectedId) await refreshDocuments();
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
			if (selectedId) await refreshDocuments();
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
			setDocumentOverlay({ kind: "none" });
			await loadLibraries();
			if (selectedId) await refreshDocuments();
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
		setDocumentOverlay({ kind: "replace", doc, file: null });
		replaceInputRef.current?.click();
	}

	function onReplaceFilePicked(files: FileList | null) {
		const file = files?.[0] ?? null;
		if (replaceInputRef.current) replaceInputRef.current.value = "";
		if (!file || !replaceDoc) {
			setDocumentOverlay({ kind: "none" });
			return;
		}
		setDocumentOverlay({ kind: "replace", doc: replaceDoc, file });
	}

	function cancelReplace() {
		if (replacing) return;
		setDocumentOverlay({ kind: "none" });
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
			setDocumentOverlay({ kind: "none" });
			await loadLibraries();
			if (selectedId) await refreshDocuments();
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
			onAcl: (doc) => setDocumentOverlay({ kind: "acl", doc }),
			onReplace: startReplace,
			onReindex: (doc) => {
				void onReindex(doc);
			},
			onDownload: (doc) => {
				void onDownload(doc);
			},
			onDelete: (doc) => setDocumentOverlay({ kind: "delete", docId: doc.id }),
		}),
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex min-h-0 flex-1 flex-col md:flex-row">
				{/* 左栏：知识库列表 */}
				<aside className="flex h-[min(40vh,21rem)] w-full shrink-0 flex-col border-b border-border/80 bg-card md:h-auto md:w-72 md:border-r md:border-b-0">
					<div className="space-y-1 border-b border-border/70 px-4 py-4">
						<p className="text-meta font-mono tracking-[0.16em] text-cite uppercase">
							Knowledge registry
						</p>
						<h2 className="font-heading text-base font-semibold">资料空间</h2>
						<p className="text-meta font-mono text-muted-foreground">
							{libraries.length} 个库 ·{" "}
							{libraries.reduce((sum, item) => sum + (item.doc_count || 0), 0)}{" "}
							份资料
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
											setDocumentQuery("");
											setDocumentOverlay({ kind: "none" });
										}}
										className={cn(
											"flex w-full items-start gap-2.5 rounded-sm border-l-2 px-2.5 py-2.5 text-left transition-colors",
											selectedId === library.id
												? "border-l-cite bg-cite/8 text-foreground"
												: "border-l-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
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
													? `${library.ready_count}/${library.doc_count} 可用 · 处理中`
													: library.status === "empty"
														? "等待资料"
														: `${library.ready_count}/${library.doc_count} 可检索`}
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
								className="w-full rounded-md border-dashed"
								disabled={savingLibrary}
								onClick={openCreateLibraryDialog}
							>
								<Plus data-icon="inline-start" />
								新建资料空间
							</Button>
						</div>
					</Can>
				</aside>

				{/* 右栏：文档表 */}
				<section className="flex min-w-0 flex-1 flex-col">
					<div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/70 bg-card px-5 py-4">
						<div className="min-w-0 space-y-1">
							<p className="text-meta font-mono tracking-[0.14em] text-cite uppercase">
								Library workspace
							</p>
							<h3 className="font-heading truncate text-xl font-semibold">
								{selectedLibrary?.name ?? "选择知识库"}
							</h3>
							{selectedLibrary?.description?.trim() ? (
								<p className="text-ui truncate text-muted-foreground">
									{selectedLibrary.description.trim()}
								</p>
							) : null}
							{selectedLibrary ? (
								<div className="flex flex-wrap gap-1.5 pt-1">
									<span className="meta-chip">
										{selectedLibrary.document_profile || "auto"} 分块
									</span>
									<span className="meta-chip">
										{selectedLibrary.parse_preference || "auto"} 解析
									</span>
									{selectedLibrary.requires_reindex ? (
										<span className="meta-chip border-survey/35 bg-accent text-accent-foreground">
											需要重索引
										</span>
									) : null}
								</div>
							) : (
								<p className="text-ui text-muted-foreground">
									{canManageLibraries
										? "从左侧选择或新建资料空间。"
										: "从左侧选择资料空间。"}
								</p>
							)}
						</div>
						<div className="flex flex-wrap items-center gap-2">
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
							{selectedLibrary && isAskableLibrary(selectedLibrary) ? (
								<Link
									href="/app/ask"
									onClick={() => {
										try {
											window.localStorage.setItem(
												ASK_LIBRARY_STORAGE_KEY,
												selectedLibrary.id,
											);
										} catch {
											// Navigation remains usable in hardened browser contexts.
										}
									}}
									className={cn(
										buttonVariants({ variant: "outline" }),
										"rounded-md",
									)}
								>
									<MessageSquareText data-icon="inline-start" />
									开始提问
								</Link>
							) : selectedLibrary ? (
								<Button
									type="button"
									variant="outline"
									className="rounded-md"
									disabled
									title="暂无可检索文档"
								>
									<MessageSquareText data-icon="inline-start" />
									开始提问
								</Button>
							) : null}
							<AuthButton
								cap="writeLibraries"
								type="button"
								className="rounded-md"
								disabled={uploadDisabled}
								onClick={() => fileInputRef.current?.click()}
							>
								<FileUp data-icon="inline-start" />
								{uploading ? "上传中…" : "上传资料"}
							</AuthButton>
							<Button
								type="button"
								variant="outline"
								size="icon-sm"
								className="rounded-md"
								disabled={loading || !selectedId}
								onClick={() => {
									void loadLibraries();
									if (selectedId) void refreshDocuments();
								}}
							>
								<RefreshCw />
								<span className="sr-only">刷新资料</span>
							</Button>
							<Can cap="manageLibraries">
								<DropdownMenu>
									<DropdownMenuTrigger
										render={
											<Button
												type="button"
												variant="outline"
												size="icon-sm"
												className="rounded-md"
												disabled={
													!selectedLibrary || savingLibrary || deletingLibrary
												}
											/>
										}
									>
										<Settings2 />
										<span className="sr-only">资料空间设置</span>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="min-w-40">
										<DropdownMenuItem
											onClick={() => {
												if (selectedLibrary)
													openEditLibraryDialog(selectedLibrary);
											}}
										>
											<Pencil />
											编辑设置
										</DropdownMenuItem>
										<DropdownMenuSeparator />
										<DropdownMenuItem
											variant="destructive"
											onClick={() => {
												if (selectedLibrary)
													setDeleteLibraryTarget(selectedLibrary);
											}}
										>
											<Trash2 />
											删除资料空间
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							</Can>
						</div>
					</div>

					{selectedLibrary ? (
						<div className="grid shrink-0 grid-cols-2 border-b border-border/70 bg-background sm:grid-cols-4">
							{[
								["可检索", documentSummary.ready],
								["处理中", documentSummary.processing],
								["需处理", documentSummary.failed],
								["知识片段", documentSummary.chunks],
							].map(([label, value], index) => (
								<div
									key={label}
									className={cn(
										"px-5 py-3",
										index > 0 && "border-l border-border/60",
										index === 2 && "border-t sm:border-t-0",
										index === 3 && "border-t sm:border-t-0",
									)}
								>
									<p className="text-meta font-mono text-muted-foreground">
										{label}
									</p>
									<p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
										{value}
									</p>
								</div>
							))}
						</div>
					) : null}

					{pageError && (
						<p className="text-ui mx-5 mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive">
							{pageError}
						</p>
					)}

					{lastUploadMs != null ? (
						<p className="text-meta mx-5 mt-2 font-mono text-muted-foreground">
							上次上传 {formatDurationMs(lastUploadMs)}
						</p>
					) : null}

					<div className="min-h-0 flex-1 px-5 py-4">
						{selectedId && documents.length > 0 ? (
							<div className="mb-3 flex flex-wrap items-end justify-between gap-3">
								<div>
									<p className="text-sm font-medium text-foreground">
										文档台账
									</p>
									<p className="text-meta mt-0.5 font-mono text-muted-foreground">
										显示 {filteredDocuments.length} / {documents.length} 份资料
									</p>
								</div>
								<div className="relative w-full sm:w-72">
									<Search
										className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
										aria-hidden
									/>
									<Input
										value={documentQuery}
										onChange={(event) => setDocumentQuery(event.target.value)}
										placeholder="搜索显示名或原文件"
										className="h-9 rounded-md pl-8"
										aria-label="搜索文档"
									/>
								</div>
							</div>
						) : null}
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
						) : filteredDocuments.length === 0 ? (
							<div className="flex min-h-48 flex-col items-center justify-center border border-dashed border-border/80 bg-muted/20 px-6 text-center">
								<p className="text-sm font-medium text-foreground">
									没有匹配的资料
								</p>
								<p className="text-ui mt-1 text-muted-foreground">
									换一个名称或文件名关键词试试。
								</p>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="mt-2"
									onClick={() => setDocumentQuery("")}
								>
									清除搜索
								</Button>
							</div>
						) : (
							<div className="max-w-full overflow-x-auto rounded-md border border-border/80">
								<Table className="table-fixed md:table-auto">
									<TableHeader>
										<TableRow className="hover:bg-transparent">
											<TableHead>显示名</TableHead>
											<TableHead className="hidden md:table-cell">
												原文件
											</TableHead>
											<TableHead className="w-24 md:w-auto">状态</TableHead>
											<TableHead className="hidden text-right md:table-cell">
												大小
											</TableHead>
											<TableHead className="hidden text-right md:table-cell">
												Chunks
											</TableHead>
											<TableHead className="hidden md:table-cell">
												更新时间
											</TableHead>
											<TableHead className="w-12 text-right">操作</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{filteredDocuments.map((doc) => {
											const busy = busyDocId === doc.id;
											const processing = doc.status === "processing";
											const actionCtx: DocActionContext = {
												busy,
												processing,
												onView: (item) =>
													setDocumentOverlay({
														kind: "detail",
														docId: item.id,
													}),
												onAcl: (item) =>
													setDocumentOverlay({ kind: "acl", doc: item }),
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
												onDelete: (item) =>
													setDocumentOverlay({
														kind: "delete",
														docId: item.id,
													}),
											};
											const actions = resolveDocActions(caps, doc);
											return (
												<TableRow
													key={doc.id}
													className="cursor-pointer"
													onClick={() =>
														setDocumentOverlay({
															kind: "detail",
															docId: doc.id,
														})
													}
												>
													<TableCell className="max-w-50">
														<span className="block truncate font-medium">
															{doc.name}
														</span>
													</TableCell>
													<TableCell className="hidden max-w-40 md:table-cell">
														<span className="text-meta block truncate font-mono text-muted-foreground">
															{doc.filename}
														</span>
													</TableCell>
													<TableCell className="w-24 md:w-auto">
														<DocumentStatusBadge
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
													<TableCell className="hidden text-right font-mono text-meta text-muted-foreground md:table-cell">
														{formatFileSize(doc.size_bytes)}
													</TableCell>
													<TableCell className="hidden text-right font-mono text-meta md:table-cell">
														{doc.chunk_count}
													</TableCell>
													<TableCell className="hidden text-meta font-mono text-muted-foreground md:table-cell">
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

			<DocumentDetailSheet
				document={detailDoc}
				versions={versionRows}
				versionsLoading={versionsLoading}
				busy={Boolean(detailDoc && busyDocId === detailDoc.id)}
				canWrite={canWriteLibraries}
				actions={detailActions}
				onClose={() => setDocumentOverlay({ kind: "none" })}
			/>

			<DocumentAclDialog
				open={aclDoc != null}
				libraryId={selectedId || null}
				doc={aclDoc}
				onOpenChange={(next) => {
					if (!next) setDocumentOverlay({ kind: "none" });
				}}
				onProjected={(item) => {
					trackProcessing([{ id: item.id, name: item.name }]);
					void loadLibraries();
					if (selectedId) void refreshDocuments();
				}}
			/>

			{/* 删除确认 */}
			<AlertDialog
				open={deleteDocId != null}
				onOpenChange={(open) => {
					if (!open) setDocumentOverlay({ kind: "none" });
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
							」并创建新版本。新版本索引成功前继续服务当前活跃版本；成功后原子切换，
							文档 ID 不变。旧版本保留在版本历史中。
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
								{libraryAdvancedOpen
									? "收起解析策略"
									: "解析策略（质量 / 扫描件）"}
							</button>
							{libraryAdvancedOpen ? (
								<div className="grid gap-3 rounded-md border border-border/70 px-3 py-2">
									<div className="grid gap-1.5">
										<Label htmlFor="library-parse-preference">
											解析质量偏好
										</Label>
										<select
											id="library-parse-preference"
											className="rounded-md border border-border bg-background px-2 py-2 text-sm"
											value={libraryParsePreference}
											disabled={savingLibrary || deletingLibrary}
											onChange={(event) =>
												setLibraryParsePreference(event.target.value)
											}
										>
											<option value="auto">自动识别</option>
											<option value="quality">强制高质量解析</option>
											<option value="local_only">严格不出域（仅本地）</option>
										</select>
										<p className="text-xs text-muted-foreground">
											只表达业务意图：不会选择自建或 302，也不会配置 API Key /
											URL。高质量在部署允许时优先增强解析；严格不出域对本库禁用增强/外部解析。若部署禁止出域而选择高质量，将回退本地并展示降级原因。
										</p>
									</div>
									<div className="grid gap-1.5">
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
											<option value="auto">允许扫描件（自动）</option>
											<option value="force_ocr">强制 OCR</option>
											<option value="disabled">
												仅文本解析（禁用扫描识别）
											</option>
										</select>
										<p className="text-xs text-muted-foreground">
											对新上传/重索引生效：自动沿用部署默认；仅文本解析不会调用
											OCR 或 MinerU，纯扫描文件会明确失败；强制 OCR
											会覆盖部署默认。更改后需重索引。
										</p>
									</div>
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
