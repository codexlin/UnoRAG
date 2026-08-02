"use client";

import type { ReactNode } from "react";

import { useSession } from "@/components/app/session-provider";
import { allowsCap, type CapExpr } from "@/lib/client-permissions";

type CanProps = {
	/** Capability expression — see CapExpr in client-permissions. */
	cap: CapExpr;
	/** Extra boolean AND (e.g. selectedId != null). */
	when?: boolean;
	/** Rendered when denied; default null (hide). */
	fallback?: ReactNode;
	children: ReactNode;
};

/** Hide children unless the session satisfies `cap` (and optional `when`). */
export function Can({ cap, when = true, fallback = null, children }: CanProps) {
	const { caps } = useSession();
	if (!when || !allowsCap(caps, cap)) return <>{fallback}</>;
	return <>{children}</>;
}

export function useCan(cap: CapExpr, when = true): boolean {
	const { caps } = useSession();
	return when && allowsCap(caps, cap);
}
