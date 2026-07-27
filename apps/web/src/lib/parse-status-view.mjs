/**
 * User-facing parse status derived from parser_report / job state.
 * Never expose Provider URLs, API keys, cost rates, or full task ids.
 */

/**
 * @typedef {{
 *   backend?: string,
 *   parser?: string,
 *   mode?: string,
 *   partial?: boolean,
 *   warnings?: string[],
 *   notes?: string,
 *   metrics?: Record<string, unknown>,
 *   [key: string]: unknown,
 * }} ParserReportLike
 *
 * @typedef {{
 *   parser_label: string | null,
 *   external_processing: boolean | null,
 *   task_status: string | null,
 *   degrade_reason: string | null,
 *   parse_quality_hint: string | null,
 *   provider_task_id: string | null,
 * }} ParseStatusView
 */

/**
 * Redact provider task id: first8…last4 (pass-through if already redacted).
 * @param {unknown} raw
 * @returns {string | null}
 */
export function redactProviderTaskId(raw) {
	if (typeof raw !== "string") return null;
	const value = raw.trim();
	if (!value) return null;
	if (value.includes("…") || value.includes("...")) return value;
	if (value.length <= 12) return value;
	return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

/**
 * @param {ParserReportLike | null | undefined} report
 * @returns {string | null}
 */
export function resolveParserLabel(report) {
	if (!report || typeof report !== "object") return null;
	const metrics =
		report.metrics && typeof report.metrics === "object" ? report.metrics : {};
	const provider =
		typeof metrics.mineru_provider === "string"
			? metrics.mineru_provider.trim().toLowerCase()
			: "";
	const backend = String(report.backend || report.parser || "")
		.trim()
		.toLowerCase();
	const route =
		typeof metrics.route === "string" ? metrics.route.trim().toLowerCase() : "";

	if (provider === "302ai" || metrics.mineru_external === true) {
		return "302 云解析";
	}
	if (
		provider === "self_hosted" ||
		backend.includes("mineru") ||
		route.startsWith("mineru")
	) {
		return "自建 MinerU";
	}
	if (
		backend.includes("pymupdf") ||
		route.startsWith("pymupdf") ||
		backend === "pdf" ||
		report.parser === "pymupdf"
	) {
		return "PyMuPDF";
	}
	if (backend || report.parser) {
		return String(report.backend || report.parser);
	}
	return null;
}

/**
 * @param {ParserReportLike | null | undefined} report
 * @returns {boolean | null}
 */
export function resolveExternalProcessing(report) {
	if (!report || typeof report !== "object") return null;
	const metrics =
		report.metrics && typeof report.metrics === "object" ? report.metrics : {};
	if (typeof metrics.mineru_external === "boolean") {
		return metrics.mineru_external;
	}
	const provider =
		typeof metrics.mineru_provider === "string"
			? metrics.mineru_provider.trim().toLowerCase()
			: "";
	if (provider === "302ai") return true;
	if (provider === "self_hosted") return false;
	const label = resolveParserLabel(report);
	if (label === "302 云解析") return true;
	if (label === "自建 MinerU" || label === "PyMuPDF") return false;
	return null;
}

/**
 * @param {{
 *   jobStatus?: string | null,
 *   jobStage?: string | null,
 *   jobPayload?: Record<string, unknown> | null,
 *   documentStatus?: string | null,
 * }} input
 * @returns {string | null}
 */
export function resolveIngestTaskStatus(input = {}) {
	const payload =
		input.jobPayload && typeof input.jobPayload === "object"
			? input.jobPayload
			: {};
	const providerState =
		payload.mineru_provider_state &&
		typeof payload.mineru_provider_state === "object"
			? /** @type {Record<string, unknown>} */ (payload.mineru_provider_state)
			: {};
	const providerStatus =
		typeof providerState.status === "string"
			? providerState.status.trim().toUpperCase()
			: "";
	if (
		providerStatus === "PENDING" ||
		providerStatus === "RUNNING" ||
		providerStatus === "STARTED" ||
		providerStatus === "WAITING"
	) {
		return "等待 302 云解析";
	}

	const jobStatus = String(input.jobStatus || "")
		.trim()
		.toLowerCase();
	const jobStage = String(input.jobStage || "")
		.trim()
		.toLowerCase();
	if (jobStatus === "queued") return "排队中";
	if (jobStatus === "running" || jobStatus === "cancelling") {
		if (jobStage === "parsing") return "解析中";
		if (jobStage === "chunking") return "切片中";
		if (jobStage === "embedding" || jobStage === "indexing") return "索引中";
		if (jobStage === "downloading") return "读取原文";
		return "处理中";
	}
	if (jobStatus === "succeeded" || jobStatus === "completed") return "已完成";
	if (jobStatus === "failed" || jobStatus === "dead") return "失败";
	if (jobStatus === "cancelled") return "已取消";

	const docStatus = String(input.documentStatus || "")
		.trim()
		.toLowerCase();
	if (docStatus === "processing") return "处理中";
	if (docStatus === "ready") return "就绪";
	if (docStatus === "degraded") return "降级可用";
	if (docStatus === "failed") return "失败";
	return docStatus || null;
}

/**
 * @param {ParserReportLike | null | undefined} report
 * @returns {string | null}
 */
export function resolveDegradeReason(report) {
	if (!report || typeof report !== "object") return null;
	const metrics =
		report.metrics && typeof report.metrics === "object" ? report.metrics : {};
	if (
		typeof metrics.degrade_reason === "string" &&
		metrics.degrade_reason.trim()
	) {
		return metrics.degrade_reason.trim();
	}
	if (
		typeof metrics.degrade_message === "string" &&
		metrics.degrade_message.trim()
	) {
		return metrics.degrade_message.trim();
	}
	const warnings = Array.isArray(report.warnings) ? report.warnings : [];
	const userWarning = warnings.find(
		(w) => typeof w === "string" && /已用基础解析|已回退|出域|熔断/.test(w),
	);
	if (typeof userWarning === "string") return userWarning;
	const route =
		typeof metrics.route === "string" ? metrics.route.trim().toLowerCase() : "";
	if (route === "pymupdf_degrade") return "增强解析不可用，已用基础解析";
	if (route === "pymupdf_no_mineru") return "未启用增强解析，使用基础解析";
	return null;
}

/**
 * @param {ParserReportLike | null | undefined} report
 * @param {{ parsePreference?: string | null }} [opts]
 * @returns {string | null}
 */
export function resolveParseQualityHint(report, opts = {}) {
	const preference = String(opts.parsePreference || "")
		.trim()
		.toLowerCase();
	if (preference === "quality") return "偏好：强制高质量解析";
	if (preference === "local_only") return "偏好：严格不出域（仅本地）";
	if (preference === "auto") return "偏好：自动识别";

	if (!report || typeof report !== "object") return null;
	const metrics =
		report.metrics && typeof report.metrics === "object" ? report.metrics : {};
	if (typeof metrics.parse_quality_hint === "string") {
		return metrics.parse_quality_hint;
	}
	const label = resolveParserLabel(report);
	if (label === "302 云解析" || label === "自建 MinerU") {
		return "已使用增强解析";
	}
	if (label === "PyMuPDF") {
		if (report.partial) return "基础解析（部分页未完成）";
		return "基础解析（PyMuPDF）";
	}
	return null;
}

/**
 * @param {{
 *   parserReport?: ParserReportLike | null,
 *   jobStatus?: string | null,
 *   jobStage?: string | null,
 *   jobPayload?: Record<string, unknown> | null,
 *   documentStatus?: string | null,
 *   parsePreference?: string | null,
 * }} input
 * @returns {ParseStatusView}
 */
export function formatParseStatusView(input = {}) {
	const report = input.parserReport ?? null;
	const metrics =
		report?.metrics && typeof report.metrics === "object"
			? report.metrics
			: {};
	const payload =
		input.jobPayload && typeof input.jobPayload === "object"
			? input.jobPayload
			: {};
	const providerState =
		payload.mineru_provider_state &&
		typeof payload.mineru_provider_state === "object"
			? /** @type {Record<string, unknown>} */ (payload.mineru_provider_state)
			: {};

	const taskId =
		redactProviderTaskId(metrics.mineru_task_id) ||
		redactProviderTaskId(providerState.task_id);

	return {
		parser_label: resolveParserLabel(report),
		external_processing: resolveExternalProcessing(report),
		task_status: resolveIngestTaskStatus(input),
		degrade_reason: resolveDegradeReason(report),
		parse_quality_hint: resolveParseQualityHint(report, {
			parsePreference: input.parsePreference,
		}),
		provider_task_id: taskId,
	};
}
