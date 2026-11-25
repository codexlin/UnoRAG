import { resolveRequestSession } from "@/lib/server/auth/session";
import {
	getOrganizationModelSettings,
	patchOrganizationModelSettings,
	testOrganizationModelConnection,
} from "@/lib/server/organization-model-settings";
import { consumeFixedWindow } from "@/lib/server/security/fixed-window-rate-limit";
import { createOrganizationModelSettingsHandlers } from "@/server/http/organization-model-settings";

const { POST_TEST } = createOrganizationModelSettingsHandlers({
	resolveIdentity: resolveRequestSession,
	read: getOrganizationModelSettings,
	patch: patchOrganizationModelSettings,
	testConnection: testOrganizationModelConnection,
	checkProbeRateLimit: ({ organizationId, principalId }) =>
		consumeFixedWindow({
			namespace: "org-model-probe",
			subject: `${organizationId}:${principalId}`,
			limit: 20,
			windowSeconds: 60,
		}),
});

export const POST = POST_TEST;
