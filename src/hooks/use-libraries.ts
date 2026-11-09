"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useSyncExternalStore } from "react";

import { useQueryScope } from "@/hooks/use-query-scope";
import { type ApiLibrary, fetchLibraries } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { fetchBackgroundQuery, fetchFreshQuery } from "@/lib/query-refresh";

const emptyLibraries: ApiLibrary[] = [];
const subscribeToHydration = () => () => undefined;

export function useLibraries() {
	const scope = useQueryScope();
	const queryClient = useQueryClient();
	const queryKey = useMemo(() => queryKeys.libraries(scope), [scope]);
	const query = useQuery({
		queryKey,
		queryFn: ({ signal }) => fetchLibraries(signal),
	});
	// The layout can fill this cache before a streamed page hydrates.
	const hydrated = useSyncExternalStore(
		subscribeToHydration,
		() => true,
		() => false,
	);

	const refresh = useCallback(async () => {
		return fetchFreshQuery(queryClient, queryKey, ({ signal }) =>
			fetchLibraries(signal),
		);
	}, [queryClient, queryKey]);
	const refreshInBackground = useCallback(
		() =>
			fetchBackgroundQuery(queryClient, queryKey, ({ signal }) =>
				fetchLibraries(signal),
			),
		[queryClient, queryKey],
	);

	return {
		libraries: hydrated ? (query.data ?? emptyLibraries) : emptyLibraries,
		error:
			hydrated && query.error
				? query.error instanceof Error
					? `知识库加载失败：${query.error.message}`
					: "知识库加载失败：API 不可用"
				: null,
		loading: !hydrated || query.isPending,
		refresh,
		refreshInBackground,
	};
}
