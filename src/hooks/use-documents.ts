"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { useQueryScope } from "@/hooks/use-query-scope";
import type {
	ApiDocument,
	ApiDocumentSummary,
	ApiDocumentsPage,
} from "@/lib/api";
import {
	type DocumentPageQueryFilter,
	documentPageQueryOptions,
	documentQueryOptions,
	documentRefetchInterval,
} from "@/lib/document-query-state";
import { fetchFreshQuery } from "@/lib/query-refresh";

const EMPTY_SUMMARY: ApiDocumentSummary = {
	total: 0,
	completed: 0,
	processing: 0,
	failed: 0,
};

export function useDocuments(
	libraryId: string,
	options: {
		enabled?: boolean;
		libraryDeleting?: boolean;
		deleteJobsActive?: boolean;
		status?: string;
		limit?: number;
		includeReport?: boolean;
	} = {},
) {
	const scope = useQueryScope();
	const queryClient = useQueryClient();
	const enabled = Boolean(libraryId) && (options.enabled ?? true);
	const queryOptions = useMemo(
		() =>
			documentQueryOptions(queryClient, scope, libraryId, {
				status: options.status,
				limit: options.limit,
				includeReport: options.includeReport,
			}),
		[
			queryClient,
			scope,
			libraryId,
			options.status,
			options.limit,
			options.includeReport,
		],
	);
	const query = useQuery({
		...queryOptions,
		enabled,
		refetchInterval: (query) =>
			documentRefetchInterval(query.state.data, {
				libraryDeleting: options.libraryDeleting,
				deleteJobsActive: options.deleteJobsActive,
				errorCount: query.state.error ? query.state.errorUpdateCount : 0,
			}),
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

export function useDocumentsPage(
	libraryId: string,
	options: DocumentPageQueryFilter & {
		enabled?: boolean;
		libraryDeleting?: boolean;
		deleteJobsActive?: boolean;
	},
) {
	const scope = useQueryScope();
	const queryClient = useQueryClient();
	const enabled = Boolean(libraryId) && (options.enabled ?? true);
	const queryOptions = useMemo(
		() =>
			documentPageQueryOptions(queryClient, scope, libraryId, {
				query: options.query,
				task: options.task,
				page: options.page,
				pageSize: options.pageSize,
			}),
		[
			queryClient,
			scope,
			libraryId,
			options.query,
			options.task,
			options.page,
			options.pageSize,
		],
	);
	const query = useQuery({
		...queryOptions,
		enabled,
		placeholderData: (previousData, previousQuery) => {
			// Only retain previous page data within the exact same workspace & library.
			const prevKey = previousQuery?.queryKey;
			if (
				!previousData ||
				!Array.isArray(prevKey) ||
				prevKey[0] !== "documents" ||
				prevKey[1] !== scope.organizationId ||
				prevKey[2] !== scope.workspaceId ||
				prevKey[3] !== libraryId
			) {
				return undefined;
			}
			return previousData;
		},
		refetchInterval: (query) =>
			documentRefetchInterval(query.state.data?.items, {
				libraryDeleting: options.libraryDeleting,
				deleteJobsActive: options.deleteJobsActive,
				errorCount: query.state.error ? query.state.errorUpdateCount : 0,
			}),
	});
	const refresh = useCallback(async () => {
		if (!enabled) return null;
		return fetchFreshQuery(
			queryClient,
			queryOptions.queryKey,
			queryOptions.queryFn,
		).catch(
			() =>
				queryClient.getQueryData<ApiDocumentsPage>(queryOptions.queryKey) ??
				null,
		);
	}, [enabled, queryClient, queryOptions]);

	return {
		documents: query.data?.items ?? [],
		total: query.data?.total ?? 0,
		filteredTotal: query.data?.filtered_total ?? 0,
		hasMore: query.data?.has_more ?? false,
		summary: query.data?.summary ?? EMPTY_SUMMARY,
		error: query.error
			? query.error instanceof Error
				? query.error.message
				: "文档列表加载失败"
			: null,
		loading: query.isPending && enabled,
		refreshing: query.isFetching && enabled,
		fetched: query.isFetched,
		queryOptions,
		refresh,
	};
}
