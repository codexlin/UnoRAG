"use client";

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
} from "react";
import { useRouter } from "next/navigation";

import {
	allowsCap,
	type CapExpr,
	type PermissionCaps,
	permissionsFor,
} from "@/lib/client-permissions";
import type { SessionIdentity } from "@/lib/session-types";

type SessionContextValue = PermissionCaps & {
	identity: SessionIdentity;
	caps: PermissionCaps;
	can: (expr: CapExpr) => boolean;
	signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({
	identity,
	children,
}: {
	identity: SessionIdentity;
	children: ReactNode;
}) {
	const router = useRouter();
	const caps = useMemo(() => permissionsFor(identity), [identity]);

	const signOut = useCallback(async () => {
		await fetch("/api/auth/session", { method: "DELETE" });
		router.replace("/login");
		router.refresh();
	}, [router]);

	const value = useMemo(
		() => ({
			identity,
			...caps,
			caps,
			can: (expr: CapExpr) => allowsCap(caps, expr),
			signOut,
		}),
		[identity, caps, signOut],
	);

	return (
		<SessionContext.Provider value={value}>{children}</SessionContext.Provider>
	);
}

export function useSession(): SessionContextValue {
	const ctx = useContext(SessionContext);
	if (!ctx) {
		throw new Error("useSession must be used within SessionProvider");
	}
	return ctx;
}
