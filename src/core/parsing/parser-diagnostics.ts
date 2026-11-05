import { z } from "zod";

const duration = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);

export const ParserTimingSchema = z.object({
	schema_version: z.literal(1),
	analysis_ms: duration,
	submission_ms: duration,
	provider_wait_ms: duration,
	result_fetch_ms: duration,
	poll_count: z.number().int().nonnegative(),
	retry_count: z.number().int().nonnegative(),
});
export type ParserTiming = z.infer<typeof ParserTimingSchema>;

export function projectParserTiming(value: unknown): ParserTiming | null {
	const parsed = ParserTimingSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}
