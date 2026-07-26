/**
 * Split parser_report into user-facing summaries vs collapsible tech details.
 * Prefer presentation-layer cleanup over changing the ingest pipeline.
 */

export const PARSER_REPORT_TITLE = "最新解析报告";

/** List/detail status badge when ingest finished via MinerU→PyMuPDF (etc.). */
export const PARSE_DEGRADED_STATUS_LABEL = "已就绪（降级）";

/** Short detail-page hint next to reindex when parse was degraded. */
export const PARSE_DEGRADED_REINDEX_HINT =
	"MinerU 恢复后可重新索引以获得更好效果";

const DEGRADE_USER = "已用基础解析（PyMuPDF）· MinerU 暂不可用";
const DEGRADE_CIRCUIT_USER = `${DEGRADE_USER}（短窗熔断）`;

const STATUS_LABELS = {
	ready: "就绪",
	indexing: "索引中",
	empty: "空库",
	processing: "处理中",
	degraded: "降级可用",
	cancelled: "已取消",
	failed: "失败",
	deleting: "删除中",
	deleted: "已删除",
	active: "活跃",
	superseded: "已替代",
	pending: "待处理",
	indexed: "已索引",
};

/**
 * @typedef {{
 *   partial?: boolean,
 *   failed_pages?: number[],
 *   needs_ocr_pages?: number[],
 *   warnings?: string[],
 *   notes?: string,
 *   metrics?: Record<string, unknown>,
 *   [key: string]: unknown,
 * }} ParserReportLike
 *
 * @typedef {{
 *   title: string,
 *   summaries: string[],
 *   techDetails: string[],
 *   empty: boolean,
 *   degraded: boolean,
 * }} ParserReportView
 *
 * @typedef {{
 *   label: string,
 *   tone: string,
 *   parseDegraded: boolean,
 * }} DocumentStatusDisplay
 */

/**
 * @param {unknown} route
 * @returns {boolean}
 */
function isDegradeRoute(route) {
	return route === "pymupdf_degrade" || route === "pymupdf_no_mineru";
}

/**
 * @param {string} warning
 * @returns {boolean}
 */
function looksLikeDegradeWarning(warning) {
	return /已用基础解析|MinerU 不可用/.test(warning);
}

/**
 * Whether parser_report indicates MinerU→PyMuPDF (or no-MinerU) degrade.
 * @param {ParserReportLike | null | undefined} report
 * @returns {boolean}
 */
export function isParserReportDegraded(report) {
	if (!report || typeof report !== "object") return false;
	const metrics =
		report.metrics && typeof report.metrics === "object" ? report.metrics : {};
	const route = typeof metrics.route === "string" ? metrics.route : "";
	if (isDegradeRoute(route)) return true;
	const warnings = Array.isArray(report.warnings) ? report.warnings : [];
	if (
		warnings.some((w) => typeof w === "string" && looksLikeDegradeWarning(w))
	) {
		return true;
	}
	const notes = typeof report.notes === "string" ? report.notes : "";
	return /mineru_degrade\s*=/i.test(notes);
}

/**
 * Resolve list/detail status badge copy from document.status + parser_report.
 * Lifecycle `degraded` stays「降级可用」; ready + parse degrade → 「已就绪（降级）」.
 * @param {string} status
 * @param {ParserReportLike | null | undefined} [parserReport]
 * @returns {DocumentStatusDisplay}
 */
export function resolveDocumentStatusDisplay(status, parserReport) {
	const parseDegraded = isParserReportDegraded(parserReport);
	const key = typeof status === "string" ? status : "";

	if (key === "degraded") {
		return { label: STATUS_LABELS.degraded, tone: "degraded", parseDegraded };
	}

	if (
		parseDegraded &&
		(key === "ready" || key === "active" || key === "indexed")
	) {
		return {
			label: PARSE_DEGRADED_STATUS_LABEL,
			tone: "degraded",
			parseDegraded: true,
		};
	}

	return {
		label:
			STATUS_LABELS[/** @type {keyof typeof STATUS_LABELS} */ (key)] ?? key,
		tone: key || "unknown",
		parseDegraded,
	};
}

/**
 * @param {string} warning
 * @returns {string | null}
 */
function extractTechFromDegradeWarning(warning) {
	const match = warning.match(
		/已用基础解析（PyMuPDF）(?:（短窗熔断）)?(?::\s*(.+))?$/,
	);
	const tech = match?.[1]?.trim();
	return tech || null;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isTechHeavy(text) {
	return (
		/Errno|Connection refused|Traceback|Exception|unreachable|mineru_degrade\s*=|Error:|failed:/i.test(
			text,
		) || /^MinerU\b/i.test(text)
	);
}

/**
 * @param {string} text
 * @returns {string}
 */
function normalizeTech(text) {
	return text
		.replace(/^;\s*/, "")
		.replace(/^mineru_degrade\s*=\s*/i, "")
		.trim();
}

/**
 * @param {string} notes
 * @returns {string[]}
 */
function extractTechFromNotes(notes) {
	const parts = notes
		.split(/;\s*/)
		.map((part) => part.trim())
		.filter(Boolean);
	/** @type {string[]} */
	const details = [];
	for (const part of parts) {
		const degrade = part.match(/^mineru_degrade\s*=\s*(.+)$/i);
		details.push(degrade ? degrade[1].trim() : part);
	}
	return details.filter(Boolean);
}

/**
 * Deduplicate tech lines; prefer the longer string when one contains another.
 * @param {string[]} items
 * @returns {string[]}
 */
export function dedupeTechDetails(items) {
	/** @type {string[]} */
	const out = [];
	for (const raw of items) {
		const item = normalizeTech(raw);
		if (!item) continue;
		let replaced = false;
		let redundant = false;
		for (let i = 0; i < out.length; i += 1) {
			const prev = out[i];
			if (prev === item) {
				redundant = true;
				break;
			}
			if (prev.includes(item)) {
				redundant = true;
				break;
			}
			if (item.includes(prev)) {
				out[i] = item;
				replaced = true;
				break;
			}
		}
		if (!redundant && !replaced) out.push(item);
	}
	return out;
}

/**
 * @param {ParserReportLike | null | undefined} report
 * @returns {ParserReportView}
 */
export function formatParserReportView(report) {
	if (!report || typeof report !== "object") {
		return {
			title: PARSER_REPORT_TITLE,
			summaries: [],
			techDetails: [],
			empty: true,
			degraded: false,
		};
	}

	const metrics =
		report.metrics && typeof report.metrics === "object" ? report.metrics : {};
	const warnings = Array.isArray(report.warnings)
		? report.warnings.filter((w) => typeof w === "string" && w.trim())
		: [];
	const notes = typeof report.notes === "string" ? report.notes : "";

	/** @type {string[]} */
	const summaries = [];
	/** @type {string[]} */
	const techRaw = [];

	const circuitOpen =
		metrics.mineru_circuit === "open" ||
		warnings.some((w) => w.includes("短窗熔断"));
	const degraded = isParserReportDegraded(report);

	if (degraded) {
		summaries.push(circuitOpen ? DEGRADE_CIRCUIT_USER : DEGRADE_USER);
	}

	if (report.partial) {
		const failedPages = Array.isArray(report.failed_pages)
			? report.failed_pages
			: [];
		const failedSuffix =
			failedPages.length > 0 ? `（失败页 ${failedPages.join(", ")}）` : "";
		summaries.push(`部分页未解析${failedSuffix}`);
	}

	if (
		Array.isArray(report.needs_ocr_pages) &&
		report.needs_ocr_pages.length > 0
	) {
		summaries.push(`建议 OCR 页：${report.needs_ocr_pages.join(", ")}`);
	}

	if (typeof metrics.mineru_error === "string" && metrics.mineru_error.trim()) {
		techRaw.push(metrics.mineru_error.trim());
	}

	for (const warning of warnings) {
		if (looksLikeDegradeWarning(warning)) {
			const tech = extractTechFromDegradeWarning(warning);
			if (tech) techRaw.push(tech);
			continue;
		}
		if (isTechHeavy(warning) || !/[\u4e00-\u9fff]/.test(warning)) {
			techRaw.push(warning);
			continue;
		}
		const alreadyCovered = summaries.some(
			(summary) => summary.includes(warning) || warning.includes(summary),
		);
		if (!alreadyCovered) summaries.push(warning);
	}

	if (notes.trim()) {
		techRaw.push(...extractTechFromNotes(notes));
	}

	const techDetails = dedupeTechDetails(techRaw);
	const empty = summaries.length === 0 && techDetails.length === 0;

	return {
		title: PARSER_REPORT_TITLE,
		summaries,
		techDetails,
		empty,
		degraded,
	};
}
