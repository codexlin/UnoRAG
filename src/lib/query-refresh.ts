import type {
	QueryClient,
	QueryFunction,
	QueryKey,
} from "@tanstack/react-query";

/** Cancel an older request before fetching authoritative post-mutation state. */
export async function fetchFreshQuery<T>(
	queryClient: QueryClient,
	queryKey: QueryKey,
	queryFn: QueryFunction<T, QueryKey>,
): Promise<T> {
	await queryClient.cancelQueries({ queryKey, exact: true });
	return queryClient.fetchQuery({ queryKey, queryFn, staleTime: 0 });
}
