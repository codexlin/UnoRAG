"use client";

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";

import { useLibraries } from "@/hooks/use-libraries";
import {
	type ApiDocument,
	fetchDocuments,
	isAbortError,
} from "@/lib/api";

const POLL_MS = 2_000;

type IngestJobsContextValue = {
	/** 当前已知仍在 processing 的文档数（跨库） */
	processingCount: number;
	/** 每次轮询成功后递增，供知识库页刷新表格 */
	tick: number;
	/** 上传/重索引刚入队时登记，避免索引太快漏 toast */
	trackProcessing: (docs: { id: string; name?: string }[]) => void;
};

const IngestJobsContext = createContext<IngestJobsContextValue | null>(null);

/**
 * App 级索引任务监听：任意路由下，有库处于 indexing 时轮询文档状态，
 * processing → ready/failed 时右上角 toast。
 */
export function IngestJobsProvider({ children }: { children: ReactNode }) {
	const { libraries, refresh } = useLibraries();
	const [processingCount, setProcessingCount] = useState(0);
	const [tick, setTick] = useState(0);
	const statusRef = useRef<Record<string, string>>({});
	const mountedRef = useRef(true);
	const librariesRef = useRef(libraries);
	librariesRef.current = libraries;

	const indexingKey = useMemo(
		() =>
			libraries
				.filter((lib) => lib.status === "indexing")
				.map((lib) => lib.id)
				.sort()
				.join(","),
		[libraries],
	);

	const trackProcessing = useCallback(
		(docs: { id: string; name?: string }[]) => {
			for (const doc of docs) {
				statusRef.current[doc.id] = "processing";
			}
			setProcessingCount((n) => Math.max(n, docs.length));
			void refresh();
		},
		[refresh],
	);

	const pollOnce = useCallback(async () => {
		const libs = librariesRef.current;
		const indexingIds = libs
			.filter((lib) => lib.status === "indexing")
			.map((lib) => lib.id);
		const trackedProcessing = Object.values(statusRef.current).some(
			(s) => s === "processing",
		);
		if (indexingIds.length === 0 && !trackedProcessing) {
			setProcessingCount(0);
			return;
		}

		const targetIds =
			indexingIds.length > 0 ? indexingIds : libs.map((lib) => lib.id);

		let processing = 0;
		try {
			const batches = await Promise.all(
				targetIds.map(async (libraryId) => {
					try {
						return await fetchDocuments(libraryId);
					} catch (err) {
						if (isAbortError(err)) return [] as ApiDocument[];
						return [] as ApiDocument[];
					}
				}),
			);
			if (!mountedRef.current) return;

			for (const docs of batches) {
				for (const doc of docs) {
					const prev = statusRef.current[doc.id];
					if (prev === "processing" && doc.status === "ready") {
						toast.success(
							`「${doc.name}」索引完成 · ${doc.chunk_count} chunks`,
						);
					} else if (prev === "processing" && doc.status === "failed") {
						toast.error(
							`「${doc.name}」索引失败：${doc.error || "未知错误"}`,
						);
					}
					statusRef.current[doc.id] = doc.status;
					if (doc.status === "processing") processing += 1;
				}
			}
			setProcessingCount(processing);
			setTick((n) => n + 1);
			await refresh();
		} catch {
			/* 下一轮再试 */
		}
	}, [refresh]);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	useEffect(() => {
		const active = indexingKey.length > 0 || processingCount > 0;
		if (!active) return;
		void pollOnce();
		const timer = window.setInterval(() => {
			void pollOnce();
		}, POLL_MS);
		return () => window.clearInterval(timer);
	}, [indexingKey, pollOnce, processingCount]);

	const value = useMemo(
		() => ({ processingCount, tick, trackProcessing }),
		[processingCount, tick, trackProcessing],
	);

	return (
		<IngestJobsContext.Provider value={value}>
			{children}
		</IngestJobsContext.Provider>
	);
}

export function useIngestJobs() {
	const ctx = useContext(IngestJobsContext);
	if (!ctx) {
		throw new Error("useIngestJobs must be used within IngestJobsProvider");
	}
	return ctx;
}
