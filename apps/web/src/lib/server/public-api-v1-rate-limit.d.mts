export function publicApiRateLimitPerMinute(): number;
export function checkPublicApiRateLimit(
	keyId: string,
	nowMs?: number,
): { ok: true } | { ok: false; retryAfterSeconds: number };
export function resetPublicApiRateLimitBuckets(): void;
