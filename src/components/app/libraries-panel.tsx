"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Can, useCan } from "@/components/app/can";
import { DocumentAclDialog } from "@/components/app/document-acl-dialog";
import { DocumentDetailSheet } from "@/components/app/document-detail-sheet";
import { useIngestJobs } from "@/components/app/ingest-jobs-provider";
import {
	DeleteDocumentDialog,
	DeleteLibraryDialog,
	LibraryEditorDialog,
	ReplaceDocumentDialog,
} from "@/components/app/libraries/library-dialogs";
import { LibraryDocumentLedger } from "@/components/app/libraries/library-document-ledger";
import {
	LibraryRegistrySidebar,
	MobileLibraryPicker,
} from "@/components/app/libraries/library-registry";
import { LibraryWorkspaceHeader } from "@/components/app/libraries/library-workspace-header";
import { buildDetailActions } from "@/components/app/library-doc-actions";
import { useSession } from "@/components/app/session-provider";
import { useDocumentVersions } from "@/hooks/use-document-versions";
import { useDocuments } from "@/hooks/use-documents";
import { useJob } from "@/hooks/use-job";
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
import { filterByCap } from "@/lib/client-permissions";
import { formatDurationMs } from "@/lib/format";

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
	const { job: detailJob, loading: detailJobLoading } = useJob(
		detailDoc?.job_id,
	);

	const deleteDoc = useMemo(
		() => documents.find((doc) => doc.id === deleteDocId) ?? null,
		[documents, deleteDocId],
	);

	useEffect(() => {
		if (libraries.length === 0) {
			if (selectedId) setSelectedId("");
			return;
		}
		const stillExists = libraries.some((item) => item.id === selectedId);
		if (!selectedId || !stillExists) {
			setSelectedId(libraries[0].id);
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
				<LibraryRegistrySidebar
					libraries={libraries}
					selectedId={selectedId}
					loading={loading}
					saving={savingLibrary}
					onSelect={(libraryId) => {
						setSelectedId(libraryId);
						setDocumentOverlay({ kind: "none" });
					}}
					onCreate={openCreateLibraryDialog}
				/>

				{/* 右栏：文档表 */}
				<section className="flex min-w-0 flex-1 flex-col">
					<MobileLibraryPicker
						libraries={libraries}
						selectedId={selectedId}
						saving={savingLibrary}
						onSelect={(libraryId) => {
							setSelectedId(libraryId);
							setDocumentOverlay({ kind: "none" });
						}}
						onCreate={openCreateLibraryDialog}
					/>

					<Can cap="writeLibraries">
						<div className="hidden">
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
						</div>
					</Can>
					<LibraryWorkspaceHeader
						library={selectedLibrary}
						documentCount={documents.length}
						canManageLibraries={canManageLibraries}
						uploading={uploading}
						uploadDisabled={uploadDisabled}
						refreshing={loading || !selectedId}
						saving={savingLibrary}
						deleting={deletingLibrary}
						onUpload={() => fileInputRef.current?.click()}
						onRefresh={() => {
							void loadLibraries();
							if (selectedId) void refreshDocuments();
						}}
						onEdit={openEditLibraryDialog}
						onDelete={setDeleteLibraryTarget}
					/>

					<LibraryDocumentLedger
						key={selectedLibrary?.id ?? "empty"}
						library={selectedLibrary}
						documents={documents}
						caps={caps}
						canManageLibraries={canManageLibraries}
						canWriteLibraries={canWriteLibraries}
						savingLibrary={savingLibrary}
						uploadDisabled={uploadDisabled}
						busyDocId={busyDocId}
						pageError={pageError}
						lastUploadMs={lastUploadMs}
						actions={{
							onView: (doc) =>
								setDocumentOverlay({ kind: "detail", docId: doc.id }),
							onAcl: (doc) => setDocumentOverlay({ kind: "acl", doc }),
							onReplace: startReplace,
							onReindex: (doc) => void onReindex(doc),
							onCancelJob: (doc) => void onCancelJob(doc),
							onRetryJob: (doc) => void onRetryJob(doc),
							onDownload: (doc) => void onDownload(doc),
							onDelete: (doc) =>
								setDocumentOverlay({ kind: "delete", docId: doc.id }),
						}}
						onCreateLibrary={openCreateLibraryDialog}
						onUpload={() => fileInputRef.current?.click()}
					/>
				</section>
			</div>

			<DocumentDetailSheet
				document={detailDoc}
				versions={versionRows}
				versionsLoading={versionsLoading}
				job={detailJob}
				jobLoading={detailJobLoading}
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

			<DeleteDocumentDialog
				open={deleteDocId != null}
				document={deleteDoc}
				busy={busyDocId === deleteDocId}
				onOpenChange={(open) => {
					if (!open) setDocumentOverlay({ kind: "none" });
				}}
				onConfirm={() => void onConfirmDelete()}
			/>

			<ReplaceDocumentDialog
				document={replaceDoc}
				file={replaceFile}
				replacing={replacing}
				onOpenChange={(open) => {
					if (!open) cancelReplace();
				}}
				onConfirm={() => void onConfirmReplace()}
			/>

			<LibraryEditorDialog
				open={libraryDialogOpen}
				mode={libraryDialogMode}
				editingLibrary={editingLibrary}
				form={{
					name: libraryName,
					description: libraryDescription,
					documentProfile: libraryDocumentProfile,
					scanHandling: libraryScanHandling,
					parsePreference: libraryParsePreference,
					advancedOpen: libraryAdvancedOpen,
				}}
				error={libraryFormError}
				saving={savingLibrary}
				deleting={deletingLibrary}
				onOpenChange={(open) => {
					if (!open) closeLibraryDialog();
				}}
				onFormChange={(patch) => {
					if (patch.name !== undefined) {
						setLibraryName(patch.name);
						if (libraryFormError) setLibraryFormError(null);
					}
					if (patch.description !== undefined)
						setLibraryDescription(patch.description);
					if (patch.documentProfile !== undefined)
						setLibraryDocumentProfile(patch.documentProfile);
					if (patch.scanHandling !== undefined)
						setLibraryScanHandling(patch.scanHandling);
					if (patch.parsePreference !== undefined)
						setLibraryParsePreference(patch.parsePreference);
					if (patch.advancedOpen !== undefined)
						setLibraryAdvancedOpen(patch.advancedOpen);
				}}
				onSubmit={() => void onSubmitLibraryForm()}
				onDelete={setDeleteLibraryTarget}
			/>

			<DeleteLibraryDialog
				library={deleteLibraryTarget}
				deleting={deletingLibrary}
				onOpenChange={(open) => {
					if (!open && !deletingLibrary) setDeleteLibraryTarget(null);
				}}
				onConfirm={() => void onConfirmDeleteLibrary()}
			/>
		</div>
	);
}
