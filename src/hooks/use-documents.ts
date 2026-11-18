"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { useQueryScope } from "@/hooks/use-query-scope";
import type { ApiDocument } from "@/lib/api";
import {
	documentQueryOptions,
	documentRefetchInterval,
} from "@/lib/document-query-state";
import { fetchFreshQuery } from "@/lib/query-refresh";

export function useDocuments(
	libraryId: string,
	options: { enabled?: boolean } = {},
) {
	const scope = useQueryScope();
	const queryClient = useQueryClient();
	const enabled = Boolean(libraryId) && (options.enabled ?? true);
	const queryOptions = useMemo(
		() => documentQueryOptions(queryClient, scope, libraryId),
		[queryClient, scope, libraryId],
	);
	const query = useQuery({
		...queryOptions,
		enabled,
		refetchInterval: (query) => documentRefetchInterval(query.state.data),
	});
	const refresh = useCallback(async () => {
		if (!enabled) return [];
		// Capture the key instead of refetching an observer that may have switched libraries.
		return fetchFreshQuery(
			queryClient,
			queryOptions.queryKey,
			queryOptions.queryFn,
		).catch(
			() =>
				queryClient.getQueryData<ApiDocument[]>(queryOptions.queryKey) ?? [],
		);
	}, [enabled, queryClient, queryOptions]);

	return {
		documents: query.data ?? [],
		error: query.error
			? query.error instanceof Error
				? query.error.message
				: "文档列表加载失败"
			: null,
		loading: query.isPending && enabled,
		refreshing: query.isFetching && enabled,
		fetched: query.isFetched,
		refresh,
	};
}
