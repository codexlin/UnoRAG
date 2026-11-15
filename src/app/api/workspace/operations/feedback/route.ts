import "server-only";

import { getDatabase } from "@/db";
import { resolveRequestSession } from "@/lib/server/auth/session";
import { createWorkspaceFeedbackHandlers } from "@/server/http/ask-feedback";
import { AskFeedbackService } from "@/server/observability/ask-feedback-service";

export const { GET, PATCH } = createWorkspaceFeedbackHandlers({
	resolveIdentity: resolveRequestSession,
	list: (scope, filters) =>
		new AskFeedbackService(getDatabase()).listFeedback(scope, filters),
	updateTriage: (scope, input) =>
		new AskFeedbackService(getDatabase()).updateTriageStatus(scope, input),
	appBaseUrl: process.env.APP_BASE_URL,
});
