export type SessionIdentity = {
	tenantId: string;
	workspaceId: string;
	workspaceName: string;
	principalId: string;
	groupIds: string[];
	organizationRole: string;
	role: string;
	email: string | null;
	displayName: string;
	provider: "local" | "oidc";
};

export const ORGANIZATION_ROLE_LABELS: Record<string, string> = {
	owner: "组织所有者",
	admin: "组织管理员",
	member: "组织成员",
};

export const ROLE_LABELS: Record<string, string> = {
	owner: "所有者",
	admin: "管理员",
	editor: "编辑者",
	viewer: "查看者",
};

export function organizationRoleLabel(role: string): string {
	return ORGANIZATION_ROLE_LABELS[role] ?? role;
}

export function roleLabel(role: string): string {
	return ROLE_LABELS[role] ?? role;
}
