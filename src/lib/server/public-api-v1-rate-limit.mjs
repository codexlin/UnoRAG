/** Public Knowledge API rate-limit configuration. Enforcement is Redis-backed. */
export function publicApiRateLimitPerMinute(environment = process.env) {
	const raw = environment.UNORAG_PUBLIC_API_RATE_LIMIT_PER_MINUTE;
	if (raw === undefined || raw === null || String(raw).trim() === "") return 0;
	const limit = Number(raw);
	if (!Number.isInteger(limit) || limit < 0 || limit > 1_000_000) {
		throw new RangeError(
			"UNORAG_PUBLIC_API_RATE_LIMIT_PER_MINUTE must be an integer from 0 to 1000000",
		);
	}
	return limit;
}
