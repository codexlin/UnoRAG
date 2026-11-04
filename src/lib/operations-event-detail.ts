export type JudgeErrorCategory =
	| "timeout"
	| "authentication"
	| "rate_limit"
	| "provider_unavailable"
	| "invalid_output"
	| "provider_error";

export type JudgeDiagnosticDetail = {
	judge_error_category?: JudgeErrorCategory;
	judge_attempts?: number;
	judge_duration_ms?: number;
	judge_timeout_ms?: number;
	judge_max_attempts?: number;
	judge_budget_ms?: number;
	judge_status_code?: number;
	judge_retryable?: boolean;
};

export type OperationsEventStage = {
	id: string;
	sequence: number;
	attempt: number | null;
	stage: string;
	outcome: string;
	error_code: string | null;
	started_at: string | null;
	ended_at: string | null;
	duration_ms: number | null;
	detail?: JudgeDiagnosticDetail | null;
};

export type OperationsEventDetail = {
	source: "ask" | "job";
	id: string;
	resource_id?: string;
	status: string;
	error_code: string | null;
	guidance: { title: string; cause: string; recovery: string };
	request_id: string | null;
	otel_trace_id: string | null;
	workflow_id: string | null;
	library_id: string | null;
	document_id: string | null;
	document_version_id: string | null;
	query_type: string | null;
	retrieval_mode: string | null;
	started_at: string;
	ended_at: string | null;
	latency_ms: number | null;
	message: string | null;
	can_retry?: boolean;
	stages: OperationsEventStage[];
};
