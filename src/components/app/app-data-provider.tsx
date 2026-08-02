"use client";

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import {
	type ApiHealth,
	type ApiLibrary,
	fetchHealth,
	fetchLibraries,
	isAbortError,
	isApiAvailable,
} from "@/lib/api";

type AppDataContextValue = {
	libraries: ApiLibrary[];
	librariesError: string | null;
	librariesLoading: boolean;
	refreshLibraries: (signal?: AbortSignal) => Promise<ApiLibrary[]>;
	health: ApiHealth | null;
	healthError: string | null;
	healthLoading: boolean;
	apiReady: boolean;
	/** Last successful/failed health probe wall time */
	healthProbedAt: number | null;
	/** Round-trip ms of last health probe */
	healthProbeMs: number | null;
	refreshHealth: (signal?: AbortSignal) => Promise<ApiHealth | null>;
};

const AppDataContext = createContext<AppDataContextValue | null>(null);

const HEALTH_POLL_MS = 15_000;

export function AppDataProvider({ children }: { children: ReactNode }) {
	const [libraries, setLibraries] = useState<ApiLibrary[]>([]);
	const [librariesError, setLibrariesError] = useState<string | null>(null);
	const [librariesLoading, setLibrariesLoading] = useState(true);
	const [health, setHealth] = useState<ApiHealth | null>(null);
	const [healthError, setHealthError] = useState<string | null>(null);
	const [healthLoading, setHealthLoading] = useState(true);
	const [healthProbedAt, setHealthProbedAt] = useState<number | null>(null);
	const [healthProbeMs, setHealthProbeMs] = useState<number | null>(null);
	const mountedRef = useRef(true);

	const refreshLibraries = useCallback(async (signal?: AbortSignal) => {
		setLibrariesLoading(true);
		try {
			const items = await fetchLibraries(signal);
			if (signal?.aborted || !mountedRef.current) return items;
			setLibraries(items);
			setLibrariesError(null);
			return items;
		} catch (err) {
			if (signal?.aborted || isAbortError(err) || !mountedRef.current) {
				return [];
			}
			setLibraries([]);
			setLibrariesError(
				err instanceof Error
					? `知识库加载失败：${err.message}`
					: "知识库加载失败：API 不可用",
			);
			return [];
		} finally {
			if (!signal?.aborted && mountedRef.current) {
				setLibrariesLoading(false);
			}
		}
	}, []);

	const refreshHealth = useCallback(async (signal?: AbortSignal) => {
		const started = performance.now();
		try {
			const payload = await fetchHealth(signal);
			if (signal?.aborted || !mountedRef.current) return payload;
			setHealth(payload);
			setHealthError(null);
			setHealthProbedAt(Date.now());
			setHealthProbeMs(Math.round(performance.now() - started));
			return payload;
		} catch (err) {
			if (signal?.aborted || isAbortError(err) || !mountedRef.current) {
				return null;
			}
			setHealth(null);
			setHealthError(err instanceof Error ? err.message : "health unavailable");
			setHealthProbedAt(Date.now());
			setHealthProbeMs(Math.round(performance.now() - started));
			return null;
		} finally {
			if (!signal?.aborted && mountedRef.current) {
				setHealthLoading(false);
			}
		}
	}, []);

	useEffect(() => {
		mountedRef.current = true;
		const libController = new AbortController();
		void refreshLibraries(libController.signal);

		const healthControllers = new Set<AbortController>();
		const probeHealth = () => {
			const controller = new AbortController();
			healthControllers.add(controller);
			void refreshHealth(controller.signal).finally(() => {
				healthControllers.delete(controller);
			});
		};
		probeHealth();
		const timer = window.setInterval(probeHealth, HEALTH_POLL_MS);

		return () => {
			mountedRef.current = false;
			libController.abort();
			window.clearInterval(timer);
			for (const controller of healthControllers) {
				controller.abort();
			}
			healthControllers.clear();
		};
	}, [refreshHealth, refreshLibraries]);

	const value = useMemo<AppDataContextValue>(
		() => ({
			libraries,
			librariesError,
			librariesLoading,
			refreshLibraries,
			health,
			healthError,
			healthLoading,
			apiReady: health ? isApiAvailable(health) : false,
			healthProbedAt,
			healthProbeMs,
			refreshHealth,
		}),
		[
			libraries,
			librariesError,
			librariesLoading,
			refreshLibraries,
			health,
			healthError,
			healthLoading,
			healthProbedAt,
			healthProbeMs,
			refreshHealth,
		],
	);

	return (
		<AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>
	);
}

function useAppData() {
	const ctx = useContext(AppDataContext);
	if (!ctx) {
		throw new Error("useAppData must be used within AppDataProvider");
	}
	return ctx;
}

export function useLibraries() {
	const {
		libraries,
		librariesError: error,
		librariesLoading: loading,
		refreshLibraries: refresh,
	} = useAppData();
	return { libraries, error, loading, refresh };
}

export function useHealth() {
	const {
		health,
		healthError: error,
		healthLoading: loading,
		apiReady,
		healthProbedAt,
		healthProbeMs,
		refreshHealth: refresh,
	} = useAppData();
	return {
		health,
		error,
		loading,
		apiReady,
		healthProbedAt,
		healthProbeMs,
		refresh,
	};
}
