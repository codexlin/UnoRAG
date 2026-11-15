import { z } from "zod";

export const ASK_FEEDBACK_RATINGS = ["up", "down"] as const;
export type AskFeedbackRating = (typeof ASK_FEEDBACK_RATINGS)[number];

export const ASK_FEEDBACK_REASON_CODES = [
	"citation_error",
	"outdated_doc",
	"missing_info",
	"hallucination",
	"other",
] as const;
export type AskFeedbackReasonCode = (typeof ASK_FEEDBACK_REASON_CODES)[number];

export const ASK_FEEDBACK_TRIAGE_STATUSES = [
	"open",
	"resolved",
	"exported",
] as const;
export type AskFeedbackTriageStatus =
	(typeof ASK_FEEDBACK_TRIAGE_STATUSES)[number];

export const ASK_FEEDBACK_REASON_LABELS: Record<AskFeedbackReasonCode, string> =
	{
		citation_error: "引用错误或无关",
		outdated_doc: "资料过期或版本不对",
		missing_info: "漏答或未检索到",
		hallucination: "存在幻觉或未拒答",
		other: "其他问题",
	};

export const ASK_FEEDBACK_TRIAGE_LABELS: Record<
	AskFeedbackTriageStatus,
	string
> = {
	open: "待处理",
	resolved: "已确认",
	exported: "已导出回归",
};

export const submitAskFeedbackSchema = z
	.strictObject({
		request_id: z.uuid(),
		rating: z.enum(ASK_FEEDBACK_RATINGS),
		reason_code: z.enum(ASK_FEEDBACK_REASON_CODES).nullable().optional(),
	})
	.superRefine((value, context) => {
		if (value.rating === "up" && value.reason_code != null) {
			context.addIssue({
				code: "custom",
				message: "reason_code must be omitted when rating is up",
				path: ["reason_code"],
			});
		}
	});

export type SubmitAskFeedbackInput = z.infer<typeof submitAskFeedbackSchema>;

export const updateFeedbackTriageSchema = z.strictObject({
	feedback_id: z.uuid(),
	triage_status: z.enum(ASK_FEEDBACK_TRIAGE_STATUSES),
});

export type UpdateFeedbackTriageInput = z.infer<
	typeof updateFeedbackTriageSchema
>;

export type AskFeedbackRecord = {
	id: string;
	request_id: string;
	library_id: string;
	query_type: string | null;
	run_status: string;
	refuse_reason: string | null;
	citation_count: number;
	latency_ms: number | null;
	used_hybrid: boolean;
	used_rerank: boolean;
	rating: AskFeedbackRating;
	reason_code: AskFeedbackReasonCode | null;
	triage_status: AskFeedbackTriageStatus;
	created_at: string;
	updated_at: string;
};

export type GoldenCaseSkeleton = {
	id: string;
	request_id: string;
	library_id: string;
	query_type: string | null;
	reason_code: AskFeedbackReasonCode | null;
	run_status: string;
	refuse_reason: string | null;
	question: string;
	target_file: string;
	key_facts: string[];
	expect_refusal: boolean;
};

/**
 * Builds a sanitized golden-case skeleton from metadata-only feedback records.
 * Operators fill in `question`, `target_file`, and `key_facts` offline without
 * storing raw user prompts in observability tables.
 */
export function buildGoldenCaseSkeleton(
	record: AskFeedbackRecord,
): GoldenCaseSkeleton {
	return {
		id: `badcase-${record.request_id.slice(0, 8)}`,
		request_id: record.request_id,
		library_id: record.library_id,
		query_type: record.query_type,
		reason_code: record.reason_code,
		run_status: record.run_status,
		refuse_reason: record.refuse_reason,
		question: "",
		target_file: "",
		key_facts: [],
		expect_refusal: record.reason_code === "hallucination",
	};
}
