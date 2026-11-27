import "server-only";

import { redactDiagnosticMessage } from "@/lib/error-diagnostics";
import { formatParseStatusView } from "@/lib/parse-status-view.mjs";
import { publicParserReport } from "@/lib/parser-report-public";

export type DocumentTaskFilter = "all" | "processing" | "failed";

export const DOCUMENT_ACTIVE_JOB_STATUSES = [
	"queued",
	"retry",
	"running",
	"cancelling",
] as const;

export const DOCUMENT_FAILED_JOB_STATUSES = ["failed", "dead"] as const;

const ALLOWED_DOCUMENT_STATUSES = new Set([
	"empty",
	"processing",
	"ready",
	"degraded",
	"failed",
	"deleting",
]);

export type DocumentListQuery = {
	paginated: boolean;
	limit: number | null;
	offset: number;
	query: string;
	task: DocumentTaskFilter;
	status: string | null;
	includeReport: boolean;
};

export function parseDocumentListQuery(url: URL): DocumentListQuery {
	const params = url.searchParams;
	const paginatedParam = params.get("paginated")?.trim().toLowerCase();
	const paginated = paginatedParam === "1" || paginatedParam === "true";

	const rawLimit = params.get("limit");
	let limit: number | null = paginated ? 50 : null;
	if (rawLimit !== null && rawLimit.trim() !== "") {
		const parsed = Number(rawLimit);
		if (Number.isFinite(parsed) && parsed > 0) {
			limit = Math.max(1, Math.min(Math.floor(parsed), 200));
		}
	}

	const rawOffset = params.get("offset");
	let offset = 0;
	if (rawOffset !== null && rawOffset.trim() !== "") {
		const parsed = Number(rawOffset);
		if (Number.isFinite(parsed) && parsed >= 0) {
			offset = Math.min(Math.floor(parsed), 1_000_000);
		}
	}

	const query = (params.get("q") ?? "").trim().slice(0, 200);

	const rawTask = (params.get("task") ?? "all").trim().toLowerCase();
	const task: DocumentTaskFilter =
		rawTask === "processing" || rawTask === "failed" ? rawTask : "all";

	const rawStatus = params.get("status")?.trim().toLowerCase() ?? "";
	const status = ALLOWED_DOCUMENT_STATUSES.has(rawStatus) ? rawStatus : null;

	const rawIncludeReport = params.get("include_report")?.trim().toLowerCase();
	const includeReport =
		rawIncludeReport === "1" || rawIncludeReport === "true"
			? true
			: rawIncludeReport === "0" || rawIncludeReport === "false"
				? false
				: !paginated;

	return {
		paginated,
		limit,
		offset,
		query,
		task,
		status,
		includeReport,
	};
}

export function escapeSqlLikePattern(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export type DocumentSerializerRow = {
	libraryRagId: string;
	document: {
		id: string;
		ragDocumentId: string;
		name: string;
		filename: string;
		contentType: string;
		status: string;
		createdAt: Date;
		updatedAt: Date;
	};
	version: {
		id: string;
		chunkCount: number | null;
		sizeBytes: number | null;
		error: string | null;
		storageKey: string | null;
		parsePreference: string | null;
		generationId: string | null;
		parserReport?: unknown;
	} | null;
	job: {
		id: string;
		status: string | null;
		stage: string | null;
		progress: number | null;
		error: string | null;
		payload?: unknown;
	} | null;
	includeReport: boolean;
};

export function serializeDocumentRow({
	libraryRagId,
	document,
	version,
	job,
	includeReport,
}: DocumentSerializerRow) {
	const base = {
		id: document.ragDocumentId,
		document_id: document.id,
		library_id: libraryRagId,
		name: document.name,
		filename: document.filename,
		content_type: document.contentType,
		status: document.status,
		chunk_count: version?.chunkCount ?? 0,
		size_bytes: version?.sizeBytes ?? null,
		error: redactDiagnosticMessage(version?.error ?? job?.error ?? null),
		has_file: Boolean(version?.storageKey),
		parse_preference: version?.parsePreference ?? null,
		document_version_id: version?.id ?? null,
		generation_id: version?.generationId ?? null,
		job_id: job?.id ?? null,
		job_status: job?.status ?? null,
		job_stage: job?.stage ?? null,
		job_progress: job?.progress ?? null,
		created_at: document.createdAt.toISOString(),
		updated_at: document.updatedAt.toISOString(),
	};
	if (!includeReport) {
		return base;
	}
	const parser_report = publicParserReport(version?.parserReport);
	const parse_status = formatParseStatusView({
		parserReport: parser_report as Record<string, unknown> | null,
		jobStatus: job?.status ?? null,
		jobStage: job?.stage ?? null,
		jobPayload: (job?.payload as Record<string, unknown> | null) ?? null,
		documentStatus: document.status,
		parsePreference: version?.parsePreference ?? null,
	});
	return {
		...base,
		parser_report,
		parse_status,
	};
}
