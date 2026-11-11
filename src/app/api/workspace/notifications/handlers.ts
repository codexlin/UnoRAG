import "server-only";

import { getDatabase } from "@/db";
import { resolveRequestSession } from "@/lib/server/auth/session";
import { createWorkspaceNotificationHandlers } from "@/server/http/workspace-notifications";
import {
	enqueueWorkspaceEmailTest,
	readWorkspaceNotifications,
	saveWorkspaceEmailSettings,
} from "@/server/observability/notification-settings";

export const { GET, PATCH, POST } = createWorkspaceNotificationHandlers({
	resolveIdentity: resolveRequestSession,
	read: (scope) => readWorkspaceNotifications(getDatabase().$client, scope),
	save: (input) => saveWorkspaceEmailSettings(getDatabase().$client, input),
	test: (input) => enqueueWorkspaceEmailTest(getDatabase().$client, input),
	appBaseUrl: process.env.APP_BASE_URL,
});
