"use client";

import { useMemo } from "react";

import { useSession } from "@/components/app/session-provider";

export function useQueryScope() {
	const { identity } = useSession();
	return useMemo(
		() => ({
			organizationId: identity.tenantId,
			workspaceId: identity.workspaceId,
		}),
		[identity.tenantId, identity.workspaceId],
	);
}
