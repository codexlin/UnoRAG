"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { useQueryScope } from "@/hooks/use-query-scope";
import { fetchDocumentVersions } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";

export function useDocumentVersions(libraryId: string, documentId: string) {
	const scope = useQueryScope();
	const enabled = Boolean(libraryId && documentId);
	const queryKey = useMemo(
		() => queryKeys.documentVersions(scope, libraryId, documentId),
		[scope, libraryId, documentId],
	);
	const query = useQuery({
		queryKey,
		queryFn: ({ signal }) =>
			fetchDocumentVersions({ libraryId, docId: documentId, signal }),
		enabled,
	});
	const refresh = useCallback(async () => {
		if (!enabled) return null;
		const result = await query.refetch();
		return result.data ?? null;
	}, [enabled, query.refetch]);

	return {
		versions: query.data?.versions ?? [],
		activeVersionId: query.data?.active_version_id ?? null,
		desiredVersionId: query.data?.desired_version_id ?? null,
		error: query.error,
		loading: query.isPending && enabled,
		refresh,
	};
}
