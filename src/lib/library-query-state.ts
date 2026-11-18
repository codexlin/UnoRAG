import type { QueryClient } from "@tanstack/react-query";

import type { ApiLibrary } from "@/lib/api";
import { type QueryScope, queryKeys } from "@/lib/query-keys";

export function libraryRefetchInterval(
	libraries: ApiLibrary[] | undefined,
	errorCount = 0,
) {
	const deleting = libraries?.filter(
		(library) => library.status === "deleting",
	);
	if (!deleting?.length) return false;
	// Failed/cancelled jobs leave the tombstone in place. Slow checks still detect external retries.
	return deleting.some((library) => library.delete_jobs_active !== false)
		? Math.min(30_000, 2_000 * 2 ** Math.min(Math.max(errorCount - 1, 0), 4))
		: 30_000;
}

/** Acceptance is authoritative; only a later library list confirms removal. */
export async function seedAcceptedLibraryDeletion(
	queryClient: QueryClient,
	scope: QueryScope,
	libraryId: string,
) {
	const queryKey = queryKeys.libraries(scope);
	await queryClient.cancelQueries({ queryKey, exact: true });
	queryClient.setQueryData<ApiLibrary[]>(queryKey, (current) =>
		current?.map((library) =>
			library.id === libraryId
				? { ...library, status: "deleting", delete_jobs_active: undefined }
				: library,
		),
	);
	// Read the real delete jobs, including failures and their existing retry actions.
	void queryClient
		.invalidateQueries({
			queryKey: queryKeys.documents(scope, libraryId),
			exact: true,
			refetchType: "active",
		})
		.catch(() => {});
}
