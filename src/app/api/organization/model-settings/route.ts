import { resolveRequestSession } from "@/lib/server/auth/session";
import {
	getOrganizationModelSettings,
	patchOrganizationModelSettings,
	testOrganizationModelConnection,
} from "@/lib/server/organization-model-settings";
import { createOrganizationModelSettingsHandlers } from "@/server/http/organization-model-settings";

export const { GET, PATCH } = createOrganizationModelSettingsHandlers({
	resolveIdentity: resolveRequestSession,
	read: getOrganizationModelSettings,
	patch: patchOrganizationModelSettings,
	testConnection: testOrganizationModelConnection,
});
