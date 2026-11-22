import type { ApiDocument } from "@/lib/api";
import { interfaceText, type Locale } from "@/lib/i18n/locale";

const ACTIVE_STATUSES = new Set(["queued", "retry", "running", "cancelling"]);

const LABELS: Record<string, readonly [string, string]> = {
	queued: ["排队中", "Queued"],
	retry: ["等待重试", "Waiting to retry"],
	running: ["处理中", "Processing"],
	cancelling: ["取消中", "Canceling"],
	completed: ["已完成", "Completed"],
	failed: ["处理失败", "Failed"],
	dead: ["重试已耗尽", "Retries exhausted"],
	cancelled: ["已取消", "Canceled"],
};

/** Task state is independent of the document's active-version availability. */
export function documentProcessingView(
	document: ApiDocument,
	locale: Locale = "zh-CN",
) {
	const t = interfaceText(locale);
	const status = document.job_status;
	const copy =
		status && Object.hasOwn(LABELS, status) ? LABELS[status] : undefined;
	const processing = Boolean(status && ACTIVE_STATUSES.has(status));
	const failed = status === "failed" || status === "dead";
	return {
		label: copy ? t(...copy) : status || t("任务未记录", "No job recorded"),
		processing,
		failed,
		completed: status === "completed",
		cancelled: status === "cancelled",
		stage: processing ? document.job_stage : null,
	};
}
