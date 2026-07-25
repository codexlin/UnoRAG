export type SessionIdentity = {
	tenantId: string;
	workspaceId: string;
	principalId: string;
	groupIds: string[];
	role: string;
	email: string | null;
	displayName: string;
	provider: "local" | "oidc";
};

export const ROLE_LABELS: Record<string, string> = {
	owner: "所有者",
	admin: "管理员",
	editor: "编辑者",
	viewer: "查看者",
};

export function roleLabel(role: string): string {
	return ROLE_LABELS[role] ?? role;
}
