import { z } from "zod";

export const OPERATIONS_REQUEST_STATUSES = [
	"running",
	"completed",
	"refused",
	"failed",
	"cancelled",
] as const;
export const OPERATIONS_REQUEST_RANGES = ["1h", "24h", "7d"] as const;
export const OPERATIONS_REQUEST_QUERY_TYPES = [
	"fact",
	"follow_up",
	"summary",
	"compare",
	"table",
	"section_lookup",
	"ambiguous",
] as const;

const integerParameter = (minimum: number, maximum: number) =>
	z
		.string()
		.regex(/^\d{1,10}$/)
		.transform(Number)
		.pipe(z.number().int().min(minimum).max(maximum));

export const operationsRequestsQuerySchema = z.strictObject({
	range: z.enum(OPERATIONS_REQUEST_RANGES).default("24h"),
	status: z.enum(OPERATIONS_REQUEST_STATUSES).optional(),
	// Public library IDs match the existing Ask event-detail contract.
	library_id: z
		.string()
		.min(1)
		.max(128)
		.regex(/^[a-zA-Z0-9_.:-]+$/)
		.optional(),
	query_type: z.enum(OPERATIONS_REQUEST_QUERY_TYPES).optional(),
	min_latency_ms: integerParameter(0, 2_147_483_647).optional(),
	request_id: z
		.uuid()
		.transform((value) => value.toLowerCase())
		.optional(),
	limit: integerParameter(1, 100).default(25),
	cursor: z
		.string()
		.min(1)
		.max(2048)
		.regex(/^[A-Za-z0-9_-]+$/)
		.optional(),
});

/** Wire query parameters; numbers are serialized as decimal strings. */
export type OperationsRequestsQuery = z.input<
	typeof operationsRequestsQuerySchema
>;
export type ParsedOperationsRequestsQuery = z.output<
	typeof operationsRequestsQuerySchema
>;

export class InvalidOperationsRequestsQuery extends Error {
	constructor() {
		super("invalid request filters or cursor");
	}
}

export function parseOperationsRequestsQuery(params: URLSearchParams) {
	if (params.toString().length > 4096)
		throw new InvalidOperationsRequestsQuery();
	const input: Record<string, string> = {};
	for (const [key, value] of params) {
		if (Object.hasOwn(input, key)) throw new InvalidOperationsRequestsQuery();
		Object.defineProperty(input, key, { value, enumerable: true });
	}
	const parsed = operationsRequestsQuerySchema.safeParse(input);
	if (!parsed.success) throw new InvalidOperationsRequestsQuery();
	return parsed.data;
}

export interface OperationsRequestRecord {
	/** Ask run ID for /api/workspace/operations/events/ask/:id. */
	id: string;
	request_id: string;
	started_at: string;
	ended_at: string | null;
	status: (typeof OPERATIONS_REQUEST_STATUSES)[number];
	query_type: string | null;
	retrieval_mode: string | null;
	latency_ms: number | null;
	citation_count: number;
	library_id: string;
}

export interface OperationsRequestsResult {
	items: OperationsRequestRecord[];
	next_cursor: string | null;
	window: { from: string; to: string };
}
