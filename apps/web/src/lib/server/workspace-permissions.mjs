/** Invite / member-role changes: owner or admin only. */
export function canManageMembers(identity) {
	return identity?.role === "owner" || identity?.role === "admin";
}

export const INVITE_ROLES = ["viewer", "editor", "admin"];

export function isAssignableInviteRole(role) {
	return INVITE_ROLES.includes(role);
}

/**
 * Pure guards for removing a workspace member (revoke access, not cascade data).
 * Membership existence is checked by the service layer.
 */
export function authorizeRemoveMember({
	actorPrincipalId,
	targetUserId,
	targetRole,
}) {
	if (!targetUserId) {
		return { ok: false, status: 400, detail: "user_id is required" };
	}
	if (targetUserId === actorPrincipalId) {
		return { ok: false, status: 400, detail: "cannot remove yourself" };
	}
	if (targetRole === "owner") {
		return { ok: false, status: 403, detail: "cannot remove owner" };
	}
	return { ok: true };
}
