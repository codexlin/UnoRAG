"use client";

import { useQuery } from "@tanstack/react-query";

import { fetchJob } from "@/lib/api";

export function useJob(jobId: string | null | undefined) {
	const enabled = Boolean(jobId);
	const query = useQuery({
		queryKey: ["job", jobId],
		queryFn: ({ signal }) => fetchJob(jobId as string, signal),
		enabled,
		refetchInterval: (current) => {
			const status = current.state.data?.status;
			return status &&
				["completed", "failed", "dead", "cancelled"].includes(status)
				? false
				: 2_000;
		},
	});
	return {
		job: query.data ?? null,
		loading: enabled && query.isPending,
		error: query.error,
	};
}
