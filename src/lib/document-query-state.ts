import type { QueryClient } from "@tanstack/react-query";

import {
	type ApiDocument,
	type ApiJob,
	fetchDocuments,
	fetchLibraries,
} from "@/lib/api";
import { TERMINAL_JOB_STATUSES } from "@/lib/document-lifecycle-contract";
import { documentProcessingView } from "@/lib/document-processing-view";
import { type QueryScope, queryKeys } from "@/lib/query-keys";
import { fetchFreshQuery } from "@/lib/query-refresh";

export function isActiveDocumentDeletion(document: ApiDocument) {
	return Boolean(
		document.status === "deleting" &&
			document.job_id &&
			documentProcessingView(document).processing,
	);
}

export function documentRefetchInterval(
	documents: ApiDocument[] | undefined,
	{
		libraryDeleting = false,
		deleteJobsActive = false,
		errorCount = 0,
	}: {
		libraryDeleting?: boolean;
		deleteJobsActive?: boolean;
		errorCount?: number;
	} = {},
) {
	if (libraryDeleting) {
		if (errorCount > 0)
			return Math.min(30_000, 2_000 * 2 ** Math.min(errorCount - 1, 4));
		// Another tab/manager may have retried while this cache still holds a failed job.
		if (deleteJobsActive) return 2_000;
		// Acceptance may precede the first successful read of the real delete jobs.
		if (
			!documents ||
			documents.some((document) => document.status !== "deleting")
		)
			return 2_000;
	}
	return documents?.some(isActiveDocumentDeletion) ? 2_000 : false;
}

export function hasFinishedDocumentDeletion(
	previous: ApiDocument[] | undefined,
	next: ApiDocument[],
) {
	return (
		previous?.some((document) => {
			if (!isActiveDocumentDeletion(document)) return false;
			const current = next.find((row) => row.id === document.id);
			return (
				!current ||
				(current.job_id === document.job_id &&
					TERMINAL_JOB_STATUSES.has(current.job_status ?? ""))
			);
		}) ?? false
	);
}

export function documentQueryOptions(
	queryClient: QueryClient,
	scope: QueryScope,
	libraryId: string,
) {
	const queryKey = queryKeys.documents(scope, libraryId);
	return {
		queryKey,
		queryFn: async ({ signal }: { signal: AbortSignal }) => {
			const previous = queryClient.getQueryData<ApiDocument[]>(queryKey);
			const documents = await fetchDocuments(libraryId, signal);
			signal.throwIfAborted();
			if (hasFinishedDocumentDeletion(previous, documents)) {
				// Count errors belong to the library query, not a successful document read.
				void fetchFreshQuery(
					queryClient,
					queryKeys.libraries(scope),
					({ signal }) => fetchLibraries(signal),
				).catch(() => {});
			}
			return documents;
		},
	};
}

/** Record only confirmed acceptance; removal still comes from the document list. */
export async function seedAcceptedDocumentDeletion(
	queryClient: QueryClient,
	scope: QueryScope,
	document: ApiDocument,
	job: Pick<ApiJob, "id" | "status"> &
		Partial<Pick<ApiJob, "stage" | "progress" | "error">>,
) {
	const queryKey = queryKeys.documents(scope, document.library_id);
	await queryClient.cancelQueries({ queryKey, exact: true });
	queryClient.setQueryData<ApiDocument[]>(queryKey, (current) =>
		current?.map((row) =>
			row.id === document.id && row.library_id === document.library_id
				? {
						...row,
						status: "deleting",
						job_id: job.id,
						job_status: job.status,
						job_stage: job.stage ?? "cleanup",
						job_progress: job.progress ?? null,
						error: job.error ?? null,
					}
				: row,
		),
	);
}
