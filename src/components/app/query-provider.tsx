"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

import { isAbortError } from "@/lib/api";

export function QueryProvider({ children }: { children: ReactNode }) {
	const [client] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: {
						staleTime: 15_000,
						gcTime: 5 * 60_000,
						refetchOnWindowFocus: true,
						refetchOnReconnect: true,
						retry: (failureCount, error) =>
							!isAbortError(error) && failureCount < 1,
					},
					mutations: {
						retry: false,
					},
				},
			}),
	);

	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
