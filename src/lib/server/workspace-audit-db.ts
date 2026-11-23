import { and, desc, eq, gte, ilike, lt, or, sql } from "drizzle-orm";

import { getDatabase } from "@/db";
import { auditLogs, users } from "@/db/schema";
import {
	AUDIT_EXPORT_MAX_ROWS,
	type AuditListItem,
	type AuditRange,
	auditRangeCutoff,
	decodeAuditCursor,
	encodeAuditCursor,
	formatAuditCsv,
	toAuditListItem,
} from "@/lib/server/workspace-audit.mjs";

export type ListAuditResult =
	| { ok: true; items: AuditListItem[]; next_cursor: string | null }
	| { ok: false; status: number; detail: string };

export type AuditFilterOptions = {
	range?: AuditRange;
	resourceType?: string | null;
	action?: string | null;
	q?: string | null;
};

function escapeLike(value: string): string {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll("%", "\\%")
		.replaceAll("_", "\\_");
}

async function queryAuditRows(
	opts: {
		organizationId: string;
		workspaceId: string;
		limit: number;
		cursor?: string | null;
	} & AuditFilterOptions,
): Promise<ListAuditResult> {
	const decoded =
		opts.cursor != null && opts.cursor !== ""
			? decodeAuditCursor(opts.cursor)
			: null;
	if (opts.cursor && !decoded) {
		return { ok: false, status: 400, detail: "invalid cursor" };
	}

	const conditions = [
		eq(auditLogs.organizationId, opts.organizationId),
		eq(auditLogs.workspaceId, opts.workspaceId),
	];

	const cutoff = opts.range ? auditRangeCutoff(opts.range) : null;
	if (cutoff) {
		conditions.push(gte(auditLogs.createdAt, cutoff));
	}

	if (opts.resourceType) {
		conditions.push(eq(auditLogs.resourceType, opts.resourceType));
	}

	if (opts.action) {
		if (opts.action.endsWith(".*")) {
			const prefix = escapeLike(opts.action.slice(0, -2));
			conditions.push(ilike(auditLogs.action, `${prefix}.%`));
		} else {
			conditions.push(eq(auditLogs.action, opts.action));
		}
	}

	if (opts.q) {
		const pattern = `%${escapeLike(opts.q)}%`;
		const searchFilter = or(
			ilike(auditLogs.action, pattern),
			ilike(auditLogs.resourceType, pattern),
			ilike(auditLogs.resourceId, pattern),
			ilike(auditLogs.requestId, pattern),
			ilike(users.displayName, pattern),
			ilike(users.email, pattern),
			sql`CAST(${auditLogs.details} AS text) ILIKE ${pattern}`,
		);
		if (searchFilter) conditions.push(searchFilter);
	}

	if (decoded) {
		const cursorAt = new Date(decoded.createdAt);
		const cursorFilter = or(
			lt(auditLogs.createdAt, cursorAt),
			and(eq(auditLogs.createdAt, cursorAt), lt(auditLogs.id, decoded.id)),
		);
		if (cursorFilter) conditions.push(cursorFilter);
	}

	const rows = await getDatabase()
		.select({
			id: auditLogs.id,
			createdAt: auditLogs.createdAt,
			actorId: auditLogs.actorId,
			action: auditLogs.action,
			resourceType: auditLogs.resourceType,
			resourceId: auditLogs.resourceId,
			requestId: auditLogs.requestId,
			details: auditLogs.details,
			ipAddress: auditLogs.ipAddress,
			userAgent: auditLogs.userAgent,
			actorDisplayName: users.displayName,
			actorEmail: users.email,
		})
		.from(auditLogs)
		.leftJoin(users, eq(users.id, auditLogs.actorId))
		.where(and(...conditions))
		.orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
		.limit(opts.limit + 1);

	const hasMore = rows.length > opts.limit;
	const page = hasMore ? rows.slice(0, opts.limit) : rows;
	const items = page.map(toAuditListItem);
	const last = page[page.length - 1];
	const next_cursor =
		hasMore && last
			? encodeAuditCursor({
					createdAt:
						last.createdAt instanceof Date
							? last.createdAt.toISOString()
							: String(last.createdAt),
					id: last.id,
				})
			: null;

	return { ok: true, items, next_cursor };
}

export async function listWorkspaceAuditLogs(
	opts: {
		organizationId: string;
		workspaceId: string;
		limit: number;
		cursor?: string | null;
	} & AuditFilterOptions,
): Promise<ListAuditResult> {
	return queryAuditRows(opts);
}

export async function exportWorkspaceAuditCsv(
	opts: {
		organizationId: string;
		workspaceId: string;
	} & AuditFilterOptions,
): Promise<{ body: string; filename: string }> {
	const result = await queryAuditRows({
		organizationId: opts.organizationId,
		workspaceId: opts.workspaceId,
		limit: AUDIT_EXPORT_MAX_ROWS,
		cursor: null,
		range: opts.range,
		resourceType: opts.resourceType,
		action: opts.action,
		q: opts.q,
	});
	if (!result.ok) {
		return { body: formatAuditCsv([]), filename: "audit-export.csv" };
	}
	const stamp = new Date().toISOString().slice(0, 10);
	return {
		body: formatAuditCsv(result.items),
		filename: `unorag-audit-${stamp}.csv`,
	};
}
