"use client";

import { isCancelledError, useQueryClient } from "@tanstack/react-query";
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
import {
	type DocumentUploadBatch,
	type DocumentUploadResult,
	LibraryUploadResults,
} from "@/components/app/libraries/library-upload-results";
import { LibraryWorkspaceHeader } from "@/components/app/libraries/library-workspace-header";
import { buildDetailActions } from "@/components/app/library-doc-actions";
import { useSession } from "@/components/app/session-provider";
import { useDocumentDetail } from "@/hooks/use-document-detail";
import { useDocumentVersions } from "@/hooks/use-document-versions";
import { useDocumentsPage } from "@/hooks/use-documents";
import { useJob } from "@/hooks/use-job";
import { useLibraries } from "@/hooks/use-libraries";
import { useQueryScope } from "@/hooks/use-query-scope";
import {
	type ApiDocument,
	type ApiLibrary,
	cancelJob,
	createLibrary,
	deleteDocument,
	deleteLibrary,
	downloadDocument,
	fetchLibraries,
	reindexDocument,
	replaceDocument,
	retryJob,
	updateLibrary,
	uploadDocument,
} from "@/lib/api";
import {
	documentPageQueryOptions,
	seedAcceptedDocumentDeletion,
} from "@/lib/document-query-state";
import { formatDurationMs } from "@/lib/format";
import { useInterfaceText } from "@/lib/i18n/provider";
import { seedAcceptedLibraryDeletion } from "@/lib/library-query-state";
import { queryKeys } from "@/lib/query-keys";
import { fetchFreshQuery } from "@/lib/query-refresh";

const DOCUMENT_PAGE_SIZE = 50;

type DocumentOverlay =
	| { kind: "none" }
	| { kind: "detail"; docId: string }
	| { kind: "delete"; docId: string }
	| { kind: "acl"; doc: ApiDocument }
	| { kind: "replace"; doc: ApiDocument; file: File | null };

export function LibrariesPanel() {
	const t = useInterfaceText();
	const { caps } = useSession();
	const queryClient = useQueryClient();
	const queryScope = useQueryScope();
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
	const selectedIdRef = useRef(selectedId);
	selectedIdRef.current = selectedId;
	const [documentQuery, setDocumentQuery] = useState("");
	const [debouncedDocumentQuery, setDebouncedDocumentQuery] = useState("");
	const [documentTaskFilter, setDocumentTaskFilter] = useState<
		"all" | "processing" | "failed"
	>("all");
	const [documentPage, setDocumentPage] = useState(1);
	const [uploading, setUploading] = useState(false);
	const [savingLibrary, setSavingLibrary] = useState(false);
	const [busyDocId, setBusyDocId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [uploadBatch, setUploadBatch] = useState<DocumentUploadBatch | null>(
		null,
	);
	const uploadSequenceRef = useRef(0);
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
	const selectedLibrary = useMemo(
		() => libraries.find((item) => item.id === selectedId) ?? null,
		[libraries, selectedId],
	);
	const selectedLibraryExists = Boolean(selectedLibrary);

	useEffect(() => {
		const trimmed = documentQuery.trim();
		if (!trimmed) {
			setDebouncedDocumentQuery("");
			return;
		}
		const timer = window.setTimeout(() => {
			setDebouncedDocumentQuery(trimmed);
		}, 200);
		return () => window.clearTimeout(timer);
	}, [documentQuery]);

	const activeDocumentFilter = useMemo(
		() => ({
			query: debouncedDocumentQuery,
			task: documentTaskFilter,
			page: documentPage,
			pageSize: DOCUMENT_PAGE_SIZE,
		}),
		[debouncedDocumentQuery, documentTaskFilter, documentPage],
	);
	const {
		documents,
		filteredTotal: documentsFilteredTotal,
		summary: documentsSummary,
		error: documentsError,
		loading: documentsLoading,
		refreshing: documentsRefreshing,
		queryOptions: documentsQueryOptions,
		refresh: refreshDocuments,
	} = useDocumentsPage(selectedId, {
		...activeDocumentFilter,
		enabled: selectedLibraryExists,
		libraryDeleting: selectedLibrary?.status === "deleting",
		deleteJobsActive: selectedLibrary?.delete_jobs_active,
	});
	const pageError =
		error ||
		librariesError ||
		(documentsError && !/404|not found/i.test(documentsError)
			? t(
					`文档列表加载失败：${documentsError}`,
					`Couldn't load documents: ${documentsError}`,
				)
			: null);
	const {
		versions: versionRows,
		activeVersionId,
		desiredVersionId,
		error: versionsError,
		loading: versionsLoading,
		refresh: refreshVersions,
	} = useDocumentVersions(selectedId, detailDocId ?? "");
	const {
		document: fetchedDetailDoc,
		loading: detailDocLoading,
		error: detailDocError,
		refresh: refreshDetailDoc,
	} = useDocumentDetail(selectedId, detailDocId, {
		enabled: selectedLibraryExists && Boolean(detailDocId),
	});

	const pageDetailDoc = useMemo(
		() => documents.find((doc) => doc.id === detailDocId) ?? null,
		[documents, detailDocId],
	);
	const detailDoc = useMemo(() => {
		if (!detailDocId) return null;
		if (fetchedDetailDoc && fetchedDetailDoc.id === detailDocId) {
			return pageDetailDoc
				? { ...pageDetailDoc, ...fetchedDetailDoc }
				: fetchedDetailDoc;
		}
		return pageDetailDoc;
	}, [detailDocId, fetchedDetailDoc, pageDetailDoc]);
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
			setDocumentQuery("");
			setDebouncedDocumentQuery("");
			setDocumentTaskFilter("all");
			setDocumentPage(1);
		}
	}, [libraries, selectedId]);

	useEffect(() => {
		const totalPages = Math.max(
			1,
			Math.ceil(documentsFilteredTotal / DOCUMENT_PAGE_SIZE),
		);
		if (documentPage > totalPages && !documentsLoading) {
			setDocumentPage(totalPages);
		}
	}, [documentsFilteredTotal, documentPage, documentsLoading]);

	useEffect(() => {
		if (!detailDocId || !selectedId || ingestTick === 0) return;
		void refreshVersions();
		void refreshDetailDoc();
	}, [detailDocId, selectedId, ingestTick, refreshVersions, refreshDetailDoc]);

	async function loadLibraries() {
		setError(null);
		await refreshLibraries();
	}

	async function onUploadFiles(files: FileList | null) {
		if (
			!files?.length ||
			!selectedLibrary ||
			selectedLibrary.status === "deleting" ||
			uploading ||
			savingLibrary ||
			!canWriteLibraries
		)
			return;
		const libraryId = selectedLibrary.id;
		const libraryKey = queryKeys.libraries(queryScope);
		const uploadPageOptions =
			libraryId === selectedId
				? documentsQueryOptions
				: documentPageQueryOptions(queryClient, queryScope, libraryId, {
						query: "",
						task: "all",
						page: 1,
						pageSize: DOCUMENT_PAGE_SIZE,
					});
		const batchId = ++uploadSequenceRef.current;
		setUploading(true);
		setError(null);
		const started = performance.now();
		setUploadBatch({
			id: batchId,
			libraryId,
			libraryName: selectedLibrary.name,
			files: Array.from(files, (file, id) => ({
				id,
				filename: file.name,
				status: "submitting",
				durationMs: null,
			})),
			durationMs: null,
		});
		function updateFile(id: number, patch: Partial<DocumentUploadResult>) {
			setUploadBatch((current) =>
				current?.id === batchId
					? {
							...current,
							files: current.files.map((file) =>
								file.id === id ? { ...file, ...patch } : file,
							),
						}
					: current,
			);
		}
		try {
			const uploads = Array.from(files, async (file, id) => {
				const fileStarted = performance.now();
				try {
					const result = await uploadDocument({ libraryId, file });
					updateFile(id, {
						status: result.status === "ready" ? "ready" : "accepted",
						docId: result.doc_id,
						durationMs: Math.round(performance.now() - fileStarted),
					});
					if (result.accepted || result.status === "processing") {
						trackProcessing([{ id: result.doc_id, name: result.title }]);
					}
					return result;
				} catch (err) {
					updateFile(id, {
						status: "failed",
						error:
							err instanceof Error
								? err.message
								: t("上传失败", "Upload failed"),
						durationMs: Math.round(performance.now() - fileStarted),
					});
					throw err;
				}
			});
			// Keep only submission metadata in the UI, not the selected file payloads.
			if (fileInputRef.current) fileInputRef.current.value = "";
			const settled = await Promise.allSettled(uploads);
			const elapsed = Math.round(performance.now() - started);
			setUploadBatch((current) =>
				current?.id === batchId ? { ...current, durationMs: elapsed } : current,
			);
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
			const accepted = acceptedDocs.length;
			const ready = ok.filter((item) => item.value.status === "ready").length;
			if (ok.length > 0) {
				if (accepted > 0) {
					const duration = formatDurationMs(elapsed);
					toast.success(
						t(
							`已提交 ${accepted} 个文件索引${ready ? `，${ready} 个已就绪` : ""} · ${duration}`,
							`${accepted} ${accepted === 1 ? "file" : "files"} submitted for indexing${ready ? `, ${ready} ready` : ""} · ${duration}`,
						),
					);
				} else {
					toast.success(
						t(
							`已上传 ${ok.length} 个文件 · ${formatDurationMs(elapsed)}`,
							`Uploaded ${ok.length} files · ${formatDurationMs(elapsed)}`,
						),
					);
				}
			}
			if (failed.length > 0) {
				const first = failed[0] as PromiseRejectedResult;
				const message =
					first.reason instanceof Error
						? first.reason.message
						: t("部分文件上传失败", "Some uploads failed");
				toast.error(message);
			}
			await Promise.all([
				fetchFreshQuery(queryClient, libraryKey, ({ signal }) =>
					fetchLibraries(signal),
				),
				fetchFreshQuery(
					queryClient,
					uploadPageOptions.queryKey,
					uploadPageOptions.queryFn,
				),
			]);
			void queryClient.invalidateQueries({
				queryKey: queryKeys.documents(queryScope, libraryId),
			});
		} catch (err) {
			const message =
				err instanceof Error
					? err.message
					: t("列表刷新失败", "Couldn't refresh the list");
			toast.error(
				t(
					`上传结果已保留，列表刷新失败：${message}`,
					`Upload results were kept, but the list could not refresh: ${message}`,
				),
			);
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
			setLibraryFormError(t("请填写知识库名称", "Enter a library name"));
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
				const libraryKey = queryKeys.libraries(queryScope);
				await queryClient.cancelQueries({ queryKey: libraryKey, exact: true });
				queryClient.setQueryData<ApiLibrary[]>(libraryKey, (current = []) => [
					created,
					...current.filter((library) => library.id !== created.id),
				]);
				setSelectedId(created.id);
				toast.success(
					t(
						`已创建知识库「${created.name}」`,
						`Created library “${created.name}”`,
					),
				);
				setLibraryDialogOpen(false);
				// A failed list refresh must not undo the confirmed creation or its upload target.
				// The scoped query hook reports refresh failures without reopening the editor.
				void refreshLibraries().catch(() => {});
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
						t(
							`已更新「${updated.name}」。文档处理预设已变更，需重新索引后才会全部生效。`,
							`Updated “${updated.name}”. Reindex documents to apply the new processing preset.`,
						),
					);
				} else {
					toast.success(
						t(
							`已更新知识库「${updated.name}」`,
							`Updated library “${updated.name}”`,
						),
					);
				}
				setLibraryDialogOpen(false);
				await loadLibraries();
			}
		} catch (err) {
			const message =
				err instanceof Error
					? err.message
					: libraryDialogMode === "create"
						? t("创建失败", "Couldn't create the library")
						: t("更新失败", "Couldn't update the library");
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
			if (
				result.accepted &&
				result.status === "deleting" &&
				result.library_id === target.id
			) {
				await seedAcceptedLibraryDeletion(queryClient, queryScope, target.id);
			}
			toast.success(
				result.accepted
					? t(
							`已排队删除知识库「${target.name}」（${result.deleted_documents} 篇文档）`,
							`Queued deletion of “${target.name}” (${result.deleted_documents} documents)`,
						)
					: t(
							`已删除知识库「${target.name}」`,
							`Deleted library “${target.name}”`,
						),
			);
			setDeleteLibraryTarget(null);
			setLibraryDialogOpen(false);
			setDocumentOverlay({ kind: "none" });
			if (!result.accepted && selectedIdRef.current === target.id) {
				setSelectedId(nextSelectedId);
			}
			// Query errors stay visible and clear on recovery; acceptance is not a delete failure.
			void refreshLibraries().catch(() => {});
		} catch (err) {
			const message =
				err instanceof Error
					? err.message
					: t("删除知识库失败", "Couldn't delete the library");
			setError(message);
			toast.error(message);
			setDeleteLibraryTarget(null);
		} finally {
			setDeletingLibrary(false);
		}
	}

	async function onReindex(doc: ApiDocument) {
		if (!doc.has_file) {
			const message = t(
				"原文未保留，请重新上传后再重索引",
				"The original file is unavailable. Upload it again before reindexing.",
			);
			setError(message);
			toast.error(message);
			return;
		}
		if (doc.status === "processing") return;
		setBusyDocId(doc.id);
		setError(null);
		try {
			if (!selectedId) {
				throw new Error(t("请先选择知识库", "Select a library first."));
			}
			const result = await reindexDocument({
				libraryId: selectedId,
				docId: doc.id,
			});
			if (result.accepted || result.status === "processing") {
				trackProcessing([{ id: result.doc_id, name: result.title }]);
				toast.success(
					t(
						`已提交重索引「${result.title}」`,
						`Queued “${result.title}” for reindexing`,
					),
				);
			} else {
				toast.success(
					t(
						`已重索引「${result.title}」· ${result.chunk_count} chunks`,
						`Reindexed “${result.title}” · ${result.chunk_count} chunks`,
					),
				);
			}
			await loadLibraries();
			if (selectedId) await refreshDocuments();
			if (detailDocId === doc.id) void refreshDetailDoc();
		} catch (err) {
			const message =
				err instanceof Error ? err.message : t("重索引失败", "Reindex failed");
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
				result.status === "cancelling"
					? t("已请求取消任务", "Cancellation requested")
					: t("任务已取消", "Job canceled"),
			);
			await loadLibraries();
			if (selectedId) await refreshDocuments();
			if (detailDocId === doc.id) void refreshDetailDoc();
		} catch (err) {
			const message =
				err instanceof Error
					? err.message
					: t("取消任务失败", "Couldn't cancel the job");
			setError(message);
			toast.error(message);
		} finally {
			setBusyDocId(null);
		}
	}

	async function onRetryJob(doc: ApiDocument) {
		if (!doc.job_id || busyDocId === doc.id) return;
		const deleting = doc.status === "deleting";
		if (deleting && !canManageLibraries) return;
		setBusyDocId(doc.id);
		setError(null);
		try {
			const result = await retryJob(doc.job_id);
			if (deleting) {
				await seedAcceptedDocumentDeletion(
					queryClient,
					queryScope,
					doc,
					result,
				);
			} else {
				trackProcessing([{ id: result.document_id, name: doc.name }]);
			}
			toast.success(
				t(`已重新提交「${doc.name}」`, `Resubmitted “${doc.name}”`),
			);
			if (deleting) {
				await refreshDeletion(doc.library_id);
			} else {
				await loadLibraries();
				if (selectedId) await refreshDocuments();
				if (detailDocId === doc.id) void refreshDetailDoc();
			}
		} catch (err) {
			const message =
				err instanceof Error
					? err.message
					: t("重试任务失败", "Couldn't retry the job");
			if (selectedIdRef.current === doc.library_id) setError(message);
			toast.error(message);
		} finally {
			setBusyDocId((current) => (current === doc.id ? null : current));
		}
	}

	async function onDownload(doc: ApiDocument) {
		if (!doc.has_file) {
			const message = t(
				"原文未保留，请重新上传后再下载",
				"The original file is unavailable. Upload it again before downloading.",
			);
			setError(message);
			toast.error(message);
			return;
		}
		setBusyDocId(doc.id);
		setError(null);
		try {
			await downloadDocument(doc.id, doc.filename);
			toast.success(
				t(
					`已开始下载「${doc.filename}」`,
					`Started downloading “${doc.filename}”`,
				),
			);
		} catch (err) {
			const message =
				err instanceof Error ? err.message : t("下载失败", "Download failed");
			setError(message);
			toast.error(message);
		} finally {
			setBusyDocId(null);
		}
	}

	async function refreshDeletion(libraryId: string) {
		const { queryKey, queryFn } =
			libraryId === selectedId
				? documentsQueryOptions
				: documentPageQueryOptions(queryClient, queryScope, libraryId, {
						query: "",
						task: "all",
						page: 1,
						pageSize: DOCUMENT_PAGE_SIZE,
					});
		// Both queries retain their original workspace/library even after navigation.
		await Promise.all([
			fetchFreshQuery(
				queryClient,
				queryKeys.libraries(queryScope),
				({ signal }) => fetchLibraries(signal),
			),
			fetchFreshQuery(queryClient, queryKey, queryFn),
		]).catch((err: unknown) => {
			if (isCancelledError(err)) return;
			const message =
				err instanceof Error
					? err.message
					: t("列表刷新失败", "Couldn't refresh the list");
			toast.error(
				t(
					`删除任务已提交，列表刷新失败：${message}`,
					`Deletion was submitted, but the list could not refresh: ${message}`,
				),
			);
		});
	}

	async function onConfirmDelete() {
		if (
			!deleteDoc ||
			busyDocId === deleteDoc.id ||
			deleteDoc.status === "deleting"
		)
			return;
		const doc = deleteDoc;
		const overlay = documentOverlay;
		setBusyDocId(doc.id);
		setError(null);
		try {
			const result = await deleteDocument({
				libraryId: doc.library_id,
				docId: doc.id,
			});
			await seedAcceptedDocumentDeletion(queryClient, queryScope, doc, {
				id: result.job_id,
				status: "queued",
			});
			toast.success(
				t(
					"已排队删除文档（后台清理向量、对象与元数据）",
					"Document deletion queued (vectors, objects, and metadata will be removed in the background)",
				),
			);
			setDocumentOverlay((current) =>
				current === overlay ? { kind: "none" } : current,
			);
			await refreshDeletion(doc.library_id);
		} catch (err) {
			const message =
				err instanceof Error ? err.message : t("删除失败", "Deletion failed");
			if (selectedIdRef.current === doc.library_id) setError(message);
			toast.error(message);
		} finally {
			setBusyDocId((current) => (current === doc.id ? null : current));
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
				toast.success(
					t(
						`已提交替换「${result.title}」，正在重新索引`,
						`Replacement submitted for “${result.title}”. Reindexing…`,
					),
				);
			} else {
				toast.success(
					t(
						`已替换「${result.title}」· ${result.chunk_count} chunks`,
						`Replaced “${result.title}” · ${result.chunk_count} chunks`,
					),
				);
			}
			setDocumentOverlay({ kind: "none" });
			await loadLibraries();
			if (selectedId) await refreshDocuments();
		} catch (err) {
			const message =
				err instanceof Error
					? err.message
					: t("替换失败", "Replacement failed");
			setError(message);
			toast.error(message);
		} finally {
			setReplacing(false);
			setBusyDocId(null);
		}
	}

	const uploadDisabled =
		uploading ||
		savingLibrary ||
		!selectedId ||
		selectedLibrary?.status === "deleting";
	const detailActions = buildDetailActions(
		caps,
		detailDoc,
		{
			onView: (doc) => setDocumentOverlay({ kind: "detail", docId: doc.id }),
			onAcl: (doc) => setDocumentOverlay({ kind: "acl", doc }),
			onReplace: startReplace,
			onReindex: (doc) => {
				void onReindex(doc);
			},
			onCancelJob: (doc) => void onCancelJob(doc),
			onRetryJob: (doc) => void onRetryJob(doc),
			onDownload: (doc) => {
				void onDownload(doc);
			},
			onDelete: (doc) => setDocumentOverlay({ kind: "delete", docId: doc.id }),
		},
		t,
	);

	function selectLibrary(libraryId: string) {
		setSelectedId(libraryId);
		setDocumentQuery("");
		setDebouncedDocumentQuery("");
		setDocumentTaskFilter("all");
		setDocumentPage(1);
		setDocumentOverlay({ kind: "none" });
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col md:overflow-hidden">
			<div className="flex min-h-0 flex-1 flex-col md:flex-row md:overflow-hidden">
				<LibraryRegistrySidebar
					libraries={libraries}
					selectedId={selectedId}
					loading={loading}
					error={librariesError}
					saving={savingLibrary}
					onSelect={selectLibrary}
					onCreate={openCreateLibraryDialog}
				/>

				{/* 右栏：文档表 */}
				<section className="flex min-h-0 min-w-0 flex-1 flex-col md:overflow-hidden">
					<MobileLibraryPicker
						libraries={libraries}
						selectedId={selectedId}
						saving={savingLibrary}
						onSelect={selectLibrary}
						onCreate={openCreateLibraryDialog}
					/>

					<Can cap="writeLibraries">
						<div className="hidden">
							<input
								ref={fileInputRef}
								type="file"
								accept=".txt,.md,.markdown,.docx,.xlsx,.pdf,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
								className="hidden"
								multiple
								onChange={(event) => void onUploadFiles(event.target.files)}
							/>
							<input
								ref={replaceInputRef}
								type="file"
								accept=".txt,.md,.markdown,.docx,.xlsx,.pdf,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
								className="hidden"
								onChange={(event) => onReplaceFilePicked(event.target.files)}
							/>
						</div>
					</Can>
					<LibraryWorkspaceHeader
						library={selectedLibrary}
						documentCount={documentsSummary.total}
						canManageLibraries={canManageLibraries}
						uploading={uploading}
						uploadDisabled={uploadDisabled}
						refreshing={loading || documentsRefreshing || !selectedId}
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

					{uploadBatch?.libraryId === selectedId ? (
						<LibraryUploadResults
							batch={uploadBatch}
							viewableDocumentIds={
								new Set(
									documents
										.filter((doc) => doc.library_id === uploadBatch.libraryId)
										.map((doc) => doc.id),
								)
							}
							onView={(docId) => setDocumentOverlay({ kind: "detail", docId })}
							onDismiss={() => setUploadBatch(null)}
						/>
					) : null}

					<LibraryDocumentLedger
						key={selectedLibrary?.id ?? "empty"}
						library={selectedLibrary}
						documents={documents}
						summary={documentsSummary}
						filteredTotal={documentsFilteredTotal}
						page={documentPage}
						pageSize={DOCUMENT_PAGE_SIZE}
						query={documentQuery}
						taskFilter={documentTaskFilter}
						onQueryChange={(nextQuery) => {
							setDocumentQuery(nextQuery);
							setDocumentPage(1);
						}}
						onTaskFilterChange={(nextTask) => {
							setDocumentTaskFilter(nextTask);
							setDocumentPage(1);
						}}
						onPageChange={(nextPage) => setDocumentPage(nextPage)}
						caps={caps}
						canManageLibraries={canManageLibraries}
						canWriteLibraries={canWriteLibraries}
						savingLibrary={savingLibrary}
						uploadDisabled={uploadDisabled}
						busyDocId={busyDocId}
						pageError={pageError}
						loading={loading || documentsLoading}
						loadError={documentsError}
						libraryLoadError={librariesError}
						refreshing={loading || documentsRefreshing}
						onRetryLoad={() => {
							if (selectedLibrary) void refreshDocuments();
							else void refreshLibraries();
						}}
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
				activeVersionId={activeVersionId}
				desiredVersionId={desiredVersionId}
				versionsError={versionsError}
				onRefreshVersions={refreshVersions}
				versionsLoading={versionsLoading}
				reportLoading={Boolean(
					detailDoc &&
						detailDoc.parser_report === undefined &&
						detailDocLoading,
				)}
				reportError={
					detailDoc && detailDoc.parser_report === undefined
						? detailDocError
						: null
				}
				onRefreshDetail={refreshDetailDoc}
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
