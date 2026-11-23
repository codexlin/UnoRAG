import { resolveRequestSession } from "@/lib/server/auth/session";
import {
	getWorkspaceAskSettings,
	patchWorkspaceAskSettings,
} from "@/lib/server/workspace-settings";
import { createWorkspaceAskSettingsHandlers } from "@/server/http/workspace-ask-settings";

export const { GET, PATCH } = createWorkspaceAskSettingsHandlers({
	resolveIdentity: resolveRequestSession,
	read: getWorkspaceAskSettings,
	patch: patchWorkspaceAskSettings,
});
