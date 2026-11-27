"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { useQueryScope } from "@/hooks/use-query-scope";
import { type ApiDocument, fetchDocumentDetail } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { fetchFreshQuery } from "@/lib/query-refresh";

export function useDocumentDetail(
	libraryId: string,
	docId: string | null,
	options: { enabled?: boolean } = {},
) {
	const scope = useQueryScope();
	const queryClient = useQueryClient();
	const enabled = Boolean(libraryId && docId) && (options.enabled ?? true);
	const queryKey = useMemo(
		() => queryKeys.documentDetail(scope, libraryId, docId ?? ""),
		[scope, libraryId, docId],
	);
	const queryFn = useCallback(
		({ signal }: { signal: AbortSignal }) =>
			fetchDocumentDetail(libraryId, docId ?? "", signal),
		[libraryId, docId],
	);
	const query = useQuery({
		queryKey,
		queryFn,
		enabled,
		retry: false,
	});
	const refresh = useCallback(async () => {
		if (!enabled) return null;
		return fetchFreshQuery(queryClient, queryKey, queryFn).catch(
			() => queryClient.getQueryData<ApiDocument>(queryKey) ?? null,
		);
	}, [enabled, queryClient, queryKey, queryFn]);

	return {
		document: query.data ?? null,
		loading: query.isPending && enabled,
		refreshing: query.isFetching && enabled,
		error: query.error,
		refresh,
	};
}
