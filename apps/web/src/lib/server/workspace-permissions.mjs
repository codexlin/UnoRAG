/** Invite / member-role changes: owner or admin only. */
export function canManageMembers(identity) {
	return identity?.role === "owner" || identity?.role === "admin";
}

export const INVITE_ROLES = ["viewer", "editor", "admin"];

export function isAssignableInviteRole(role) {
	return INVITE_ROLES.includes(role);
}
