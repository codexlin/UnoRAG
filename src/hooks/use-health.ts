"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { useQueryScope } from "@/hooks/use-query-scope";
import { fetchHealth, isApiAvailable } from "@/lib/api";
import {
	resolveHealthQueryState,
	runTimedHealthProbe,
} from "@/lib/health-query-state";
import { queryKeys } from "@/lib/query-keys";
import { fetchFreshQuery } from "@/lib/query-refresh";

function probeHealth(signal?: AbortSignal) {
	return runTimedHealthProbe(() => fetchHealth(signal));
}

export function useHealth() {
	const scope = useQueryScope();
	const queryClient = useQueryClient();
	const queryKey = useMemo(() => queryKeys.health(scope), [scope]);
	const query = useQuery({
		queryKey,
		queryFn: ({ signal }) => probeHealth(signal),
		refetchInterval: 15_000,
		refetchIntervalInBackground: false,
	});

	const refresh = useCallback(async () => {
		const result = await fetchFreshQuery(queryClient, queryKey, ({ signal }) =>
			probeHealth(signal),
		);
		return result.payload;
	}, [queryClient, queryKey]);

	const state = resolveHealthQueryState({
		data: query.data,
		error:
			query.error instanceof Error
				? query.error
				: query.error
					? new Error("health unavailable")
					: null,
		isAvailable: isApiAvailable,
	});
	return {
		...state,
		loading: query.isPending,
		refresh,
	};
}
