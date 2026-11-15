import "server-only";

import { getDatabase } from "@/db";
import { resolveRequestSession } from "@/lib/server/auth/session";
import { createAskFeedbackHandlers } from "@/server/http/ask-feedback";
import { AskFeedbackService } from "@/server/observability/ask-feedback-service";

export const { POST } = createAskFeedbackHandlers({
	resolveIdentity: resolveRequestSession,
	submit: (scope, input) =>
		new AskFeedbackService(getDatabase()).submitFeedback(scope, input),
	appBaseUrl: process.env.APP_BASE_URL,
});
