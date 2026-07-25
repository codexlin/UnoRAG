export type AuditAuthResult =
	| { ok: true }
	| { ok: false; status: number; detail: string };

export type AuditListParams = {
	limit: number;
	cursor: string | null;
	format: string | null;
};

export type AuditCursor = {
	createdAt: string;
	id: string;
};

export type AuditListItem = {
	id: string;
	created_at: string;
	actor: {
		id: string | null;
		display_name: string | null;
		email: string | null;
		label: string | null;
	};
	action: string;
	resource: {
		type: string;
		id: string | null;
	};
	metadata_summary: string;
	request_id: string | null;
};

export function authorizeAuditAccess(
	identity: { role?: string } | null | undefined,
): AuditAuthResult;

export function parseAuditListParams(
	searchParams: URLSearchParams,
): AuditListParams;

export function encodeAuditCursor(cursor: AuditCursor): string;

export function decodeAuditCursor(cursor: string | null | undefined): AuditCursor | null;

export function summarizeAuditDetails(
	details: unknown,
	maxLen?: number,
): string;

export function toAuditListItem(row: {
	id: string;
	createdAt: Date | string;
	actorId?: string | null;
	actorDisplayName?: string | null;
	actorEmail?: string | null;
	action: string;
	resourceType: string;
	resourceId?: string | null;
	requestId?: string | null;
	details?: unknown;
}): AuditListItem;

export const AUDIT_CSV_HEADERS: string[];

export function formatAuditCsv(items: AuditListItem[]): string;

export const AUDIT_EXPORT_MAX_ROWS: number;
