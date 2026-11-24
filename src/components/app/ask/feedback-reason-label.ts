import {
	ASK_FEEDBACK_REASON_LABELS,
	type AskFeedbackReasonCode,
} from "@/lib/ask-feedback";
import type { useInterfaceText } from "@/lib/i18n/provider";

const ENGLISH_REASONS: Record<AskFeedbackReasonCode, string> = {
	citation_error: "Wrong or irrelevant citation",
	outdated_doc: "Outdated or wrong version",
	missing_info: "Missing answer or not retrieved",
	hallucination: "Hallucination or missed refusal",
	other: "Other issue",
};

export function feedbackReasonLabel(
	code: AskFeedbackReasonCode,
	t: ReturnType<typeof useInterfaceText>,
) {
	return t(ASK_FEEDBACK_REASON_LABELS[code], ENGLISH_REASONS[code]);
}
