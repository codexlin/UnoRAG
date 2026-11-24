import type { useInterfaceText } from "@/lib/i18n/provider";
import { roleLabel } from "@/lib/session-types";

const ENGLISH_ROLES: Record<string, string> = {
	owner: "Owner",
	admin: "Admin",
	editor: "Editor",
	viewer: "Viewer",
};

export function workspaceRoleLabel(
	role: string,
	t: ReturnType<typeof useInterfaceText>,
) {
	return t(roleLabel(role), ENGLISH_ROLES[role] ?? role);
}
