/**
 * Workspace audit list / CSV helpers.
 *
 * Schema fields today: action, resource_type/id, actor_id (nullable — worker
 * jobs often omit actor), details jsonb, request_id (optional), created_at.
 * UI/CSV only surface what is stored; do not invent actor or IP when absent.
 * Follow-up hardening: richer actor labels, ip/ua columns, action i18n.
 */

import { canManageMembers } from "./workspace-permissions.mjs";

/** owner | admin only — same gate as member management. */
export function authorizeAuditAccess(identity) {
	if (!identity) {
		return { ok: false, status: 401, detail: "authentication required" };
	}
	if (!canManageMembers(identity)) {
		return { ok: false, status: 403, detail: "forbidden" };
	}
	return { ok: true };
}

export function parseAuditListParams(searchParams) {
	const rawLimit = Number(searchParams.get("limit") ?? 50);
	const limit =
		Number.isSafeInteger(rawLimit) && rawLimit > 0
			? Math.min(rawLimit, 200)
			: 50;
	const cursor = searchParams.get("cursor")?.trim() || null;
	const format = searchParams.get("format")?.trim()?.toLowerCase() || null;
	return { limit, cursor, format };
}

export function encodeAuditCursor({ createdAt, id }) {
	return Buffer.from(JSON.stringify({ createdAt, id }), "utf8").toString(
		"base64url",
	);
}

export function decodeAuditCursor(cursor) {
	if (!cursor) return null;
	try {
		const parsed = JSON.parse(
			Buffer.from(cursor, "base64url").toString("utf8"),
		);
		if (
			typeof parsed?.createdAt !== "string" ||
			typeof parsed?.id !== "string" ||
			!parsed.createdAt ||
			!parsed.id
		) {
			return null;
		}
		const t = Date.parse(parsed.createdAt);
		if (Number.isNaN(t)) return null;
		return { createdAt: parsed.createdAt, id: parsed.id };
	} catch {
		return null;
	}
}

function truncate(text, maxLen) {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

/**
 * Compact summary from stored details only (preferred known keys, else JSON).
 */
export function summarizeAuditDetails(details, maxLen = 160) {
	if (details == null) return "";
	if (typeof details === "string") return truncate(details, maxLen);
	if (typeof details !== "object") return truncate(String(details), maxLen);

	const preferredKeys = [
		"library_id",
		"job_id",
		"document_version_id",
		"generation_id",
		"content_hash",
		"size_bytes",
		"reason",
		"status",
		"point_count",
	];
	const preferred = [];
	for (const key of preferredKeys) {
		if (details[key] != null && details[key] !== "") {
			preferred.push(`${key}=${String(details[key])}`);
		}
	}
	const text =
		preferred.length > 0 ? preferred.join("; ") : JSON.stringify(details);
	return truncate(text, maxLen);
}

export function toAuditListItem(row) {
	const createdAt =
		row.createdAt instanceof Date
			? row.createdAt.toISOString()
			: String(row.createdAt ?? "");
	const actorId = row.actorId ?? null;
	const displayName = row.actorDisplayName ?? null;
	const email = row.actorEmail ?? null;
	const label = displayName || email || actorId || null;

	return {
		id: row.id,
		created_at: createdAt,
		actor: {
			id: actorId,
			display_name: displayName,
			email,
			label,
		},
		action: row.action,
		resource: {
			type: row.resourceType,
			id: row.resourceId ?? null,
		},
		metadata_summary: summarizeAuditDetails(row.details),
		request_id: row.requestId ?? null,
	};
}

export const AUDIT_CSV_HEADERS = [
	"created_at",
	"actor_id",
	"actor_display_name",
	"actor_email",
	"action",
	"resource_type",
	"resource_id",
	"metadata_summary",
	"request_id",
];

function csvEscape(value) {
	const s = value == null ? "" : String(value);
	if (/[",\n\r]/.test(s)) {
		return `"${s.replace(/"/g, '""')}"`;
	}
	return s;
}

export function formatAuditCsv(items) {
	const lines = [AUDIT_CSV_HEADERS.join(",")];
	for (const item of items) {
		lines.push(
			[
				item.created_at ?? "",
				item.actor?.id ?? "",
				item.actor?.display_name ?? "",
				item.actor?.email ?? "",
				item.action ?? "",
				item.resource?.type ?? "",
				item.resource?.id ?? "",
				item.metadata_summary ?? "",
				item.request_id ?? "",
			]
				.map(csvEscape)
				.join(","),
		);
	}
	return `${lines.join("\n")}\n`;
}

/** Max rows for a single CSV export (harden later with async export jobs). */
export const AUDIT_EXPORT_MAX_ROWS = 5000;
