"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { useQueryScope } from "@/hooks/use-query-scope";
import { fetchLibraries } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { fetchFreshQuery } from "@/lib/query-refresh";

export function useLibraries() {
	const scope = useQueryScope();
	const queryClient = useQueryClient();
	const queryKey = useMemo(() => queryKeys.libraries(scope), [scope]);
	const query = useQuery({
		queryKey,
		queryFn: ({ signal }) => fetchLibraries(signal),
	});

	const refresh = useCallback(async () => {
		return fetchFreshQuery(queryClient, queryKey, ({ signal }) =>
			fetchLibraries(signal),
		);
	}, [queryClient, queryKey]);

	return {
		libraries: query.data ?? [],
		error: query.error
			? query.error instanceof Error
				? `知识库加载失败：${query.error.message}`
				: "知识库加载失败：API 不可用"
			: null,
		loading: query.isPending,
		refresh,
	};
}
