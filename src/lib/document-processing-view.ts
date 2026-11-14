import type { ApiDocument } from "@/lib/api";

const ACTIVE_STATUSES = new Set(["queued", "retry", "running", "cancelling"]);

const LABELS: Record<string, string> = {
	queued: "排队中",
	retry: "等待重试",
	running: "处理中",
	cancelling: "取消中",
	completed: "已完成",
	failed: "处理失败",
	dead: "重试已耗尽",
	cancelled: "已取消",
};

/** Task state is independent of the document's active-version availability. */
export function documentProcessingView(document: ApiDocument) {
	const status = document.job_status;
	const processing = Boolean(status && ACTIVE_STATUSES.has(status));
	const failed = status === "failed" || status === "dead";
	return {
		label: status ? (LABELS[status] ?? status) : "任务未记录",
		processing,
		failed,
		completed: status === "completed",
		cancelled: status === "cancelled",
		stage: processing ? document.job_stage : null,
	};
}
