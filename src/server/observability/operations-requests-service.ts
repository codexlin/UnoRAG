import { createHash } from "node:crypto";

import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";

import type * as schema from "@/db/schema";
import { askRuns } from "@/db/schema";
import {
	InvalidOperationsRequestsQuery,
	OPERATIONS_REQUEST_QUERY_TYPES,
	OPERATIONS_REQUEST_STATUSES,
	type OperationsRequestsResult,
	type ParsedOperationsRequestsQuery,
	parseOperationsRequestsQuery,
} from "@/lib/operations-requests";

interface OperationsRequestsScope {
	organizationId: string;
	workspaceId: string;
}

const rangeMs = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000 };
const cursorSchema = z.strictObject({
	v: z.literal(1),
	filter: z.string().regex(/^[a-f0-9]{64}$/),
	from: z.iso.datetime(),
	to: z.iso.datetime(),
	started_at: z.iso.datetime({ precision: 6 }),
	id: z.uuid(),
});

function filterKey(
	scope: OperationsRequestsScope,
	query: ParsedOperationsRequestsQuery,
) {
	return createHash("sha256")
		.update(
			JSON.stringify([
				scope.organizationId,
				scope.workspaceId,
				query.range,
				query.status,
				query.library_id,
				query.query_type,
				query.min_latency_ms,
				query.request_id,
			]),
		)
		.digest("hex");
}

export class OperationsRequestsService {
	constructor(private readonly db: NodePgDatabase<typeof schema>) {}

	async list(
		scope: OperationsRequestsScope,
		params: URLSearchParams,
		now = new Date(),
	): Promise<OperationsRequestsResult> {
		if (
			!z.uuid().safeParse(scope.organizationId).success ||
			!z.uuid().safeParse(scope.workspaceId).success
		) {
			throw new Error("organizationId and workspaceId are required");
		}
		const query = parseOperationsRequestsQuery(params);
		const filter = filterKey(scope, query);
		let from = new Date(now.getTime() - rangeMs[query.range]).toISOString();
		let to = now.toISOString();
		let cursor: z.infer<typeof cursorSchema> | undefined;
		if (query.cursor) {
			try {
				cursor = cursorSchema.parse(
					JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")),
				);
				const end = Date.parse(cursor.to);
				if (
					cursor.filter !== filter ||
					end > now.getTime() ||
					now.getTime() - end > rangeMs["1h"] ||
					end - Date.parse(cursor.from) !== rangeMs[query.range] ||
					Date.parse(cursor.started_at) < Date.parse(cursor.from) ||
					Date.parse(cursor.started_at) > end
				)
					throw new Error();
				from = cursor.from;
				to = cursor.to;
			} catch {
				throw new InvalidOperationsRequestsQuery();
			}
		}

		const rows = await this.db.transaction(async (tx) => {
			await tx.execute(sql`set local statement_timeout = '5s'`);
			return tx
				.select({
					id: askRuns.id,
					request_id: askRuns.requestId,
					// Preserve PostgreSQL microseconds for exact keyset boundaries.
					started_at: sql<string>`to_char(${askRuns.startedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
					ended_at: askRuns.endedAt,
					status: askRuns.status,
					query_type: askRuns.queryType,
					retrieval_mode: askRuns.retrievalMode,
					latency_ms: askRuns.latencyMs,
					citation_count: askRuns.citationCount,
					library_id: askRuns.ragLibraryId,
				})
				.from(askRuns)
				.where(
					and(
						eq(askRuns.organizationId, scope.organizationId),
						eq(askRuns.workspaceId, scope.workspaceId),
						sql`${askRuns.startedAt} >= ${from}::timestamptz`,
						sql`${askRuns.startedAt} <= ${to}::timestamptz`,
						query.status ? eq(askRuns.status, query.status) : undefined,
						query.library_id
							? eq(askRuns.ragLibraryId, query.library_id)
							: undefined,
						query.query_type
							? eq(askRuns.queryType, query.query_type)
							: undefined,
						query.min_latency_ms !== undefined
							? gte(askRuns.latencyMs, query.min_latency_ms)
							: undefined,
						query.request_id
							? eq(askRuns.requestId, query.request_id)
							: undefined,
						cursor
							? sql`(${askRuns.startedAt}, ${askRuns.id}) < (${cursor.started_at}::timestamptz, ${cursor.id}::uuid)`
							: undefined,
					),
				)
				.orderBy(desc(askRuns.startedAt), desc(askRuns.id))
				.limit(query.limit + 1);
		});

		const page = rows.slice(0, query.limit);
		const last = page.at(-1);
		return {
			items: page.map((row) => ({
				...row,
				status: z.enum(OPERATIONS_REQUEST_STATUSES).parse(row.status),
				query_type:
					z.enum(OPERATIONS_REQUEST_QUERY_TYPES).safeParse(row.query_type)
						.data ?? null,
				retrieval_mode:
					row.retrieval_mode === "dense" || row.retrieval_mode === "hybrid"
						? row.retrieval_mode
						: null,
				ended_at: row.ended_at?.toISOString() ?? null,
			})),
			next_cursor:
				rows.length > query.limit && last
					? Buffer.from(
							JSON.stringify({
								v: 1,
								filter,
								from,
								to,
								started_at: last.started_at,
								id: last.id,
							}),
						).toString("base64url")
					: null,
			window: { from, to },
		};
	}
}
