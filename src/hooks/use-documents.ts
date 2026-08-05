"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { useQueryScope } from "@/hooks/use-query-scope";
import { fetchDocuments } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";

export function useDocuments(
	libraryId: string,
	options: { enabled?: boolean } = {},
) {
	const scope = useQueryScope();
	const enabled = Boolean(libraryId) && (options.enabled ?? true);
	const queryKey = useMemo(
		() => queryKeys.documents(scope, libraryId),
		[scope, libraryId],
	);
	const query = useQuery({
		queryKey,
		queryFn: ({ signal }) => fetchDocuments(libraryId, signal),
		enabled,
	});
	const refresh = useCallback(async () => {
		if (!enabled) return [];
		const result = await query.refetch();
		return result.data ?? [];
	}, [enabled, query.refetch]);

	return {
		documents: query.data ?? [],
		error: query.error
			? query.error instanceof Error
				? query.error.message
				: "文档列表加载失败"
			: null,
		loading: query.isPending && enabled,
		fetched: query.isFetched,
		refresh,
	};
}
