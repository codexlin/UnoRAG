const ORGANIZATION_ADMIN_ROLES = new Set(["owner", "admin"]);

/** Organization-level workspace creation is intentionally separate from workspace RBAC. */
export function canCreateWorkspaces(identity) {
	return ORGANIZATION_ADMIN_ROLES.has(identity?.organizationRole);
}
