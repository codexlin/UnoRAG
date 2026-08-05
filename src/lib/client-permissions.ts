import type { SessionIdentity } from "@/lib/session-types";

export type PermissionCaps = {
	canWriteLibraries: boolean;
	canManageLibraries: boolean;
	canManageMembers: boolean;
};

/** Named UI/API capabilities (extend as product needs grow). */
export type Cap =
	| "read"
	| "writeLibraries"
	| "manageLibraries"
	| "manageMembers";

/**
 * Flexible gate expression:
 * - single Cap
 * - Cap[] → all must pass (AND)
 * - { anyOf } / { allOf }
 * - predicate over resolved caps
 */
export type CapExpr =
	| Cap
	| Cap[]
	| { anyOf: Cap[] }
	| { allOf: Cap[] }
	| ((caps: PermissionCaps) => boolean);

/** Mirrors server library/workspace permission helpers for UI gating. */
export function permissionsFor(
	identity: SessionIdentity | null,
): PermissionCaps {
	const role = identity?.role;
	const canManageLibraries = role === "owner" || role === "admin";
	const canWriteLibraries = canManageLibraries || role === "editor";
	const canManageMembers = canManageLibraries;
	return {
		canWriteLibraries,
		canManageLibraries,
		canManageMembers,
	};
}

function hasCap(caps: PermissionCaps, cap: Cap): boolean {
	switch (cap) {
		case "read":
			return true;
		case "writeLibraries":
			return caps.canWriteLibraries;
		case "manageLibraries":
			return caps.canManageLibraries;
		case "manageMembers":
			return caps.canManageMembers;
		default:
			return false;
	}
}

export function allowsCap(caps: PermissionCaps, expr: CapExpr): boolean {
	if (typeof expr === "function") return expr(caps);
	if (typeof expr === "string") return hasCap(caps, expr);
	if (Array.isArray(expr)) return expr.every((cap) => hasCap(caps, cap));
	if ("anyOf" in expr) return expr.anyOf.some((cap) => hasCap(caps, cap));
	if ("allOf" in expr) return expr.allOf.every((cap) => hasCap(caps, cap));
	return false;
}

export function filterByCap<T extends { cap: CapExpr }>(
	caps: PermissionCaps,
	items: T[],
): T[] {
	return items.filter((item) => allowsCap(caps, item.cap));
}
