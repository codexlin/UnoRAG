/**
 * Optional process-local rate limit for Public API v1.
 * Disabled when MERIKNOW_PUBLIC_API_RATE_LIMIT_PER_MINUTE is unset/0.
 * Multi-instance deployments should use Redis/Ingress; this only hardens single-node.
 */

const buckets = new Map();

export function publicApiRateLimitPerMinute() {
	const raw = process.env.MERIKNOW_PUBLIC_API_RATE_LIMIT_PER_MINUTE;
	if (raw === undefined || raw === null || String(raw).trim() === "") {
		return 0;
	}
	const limit = Number(raw);
	if (!Number.isFinite(limit) || limit <= 0) return 0;
	return Math.floor(limit);
}

/**
 * @param {string} keyId
 * @param {number} [nowMs]
 * @returns {{ ok: true } | { ok: false, retryAfterSeconds: number }}
 */
export function checkPublicApiRateLimit(keyId, nowMs = Date.now()) {
	const limit = publicApiRateLimitPerMinute();
	if (!limit) return { ok: true };
	const id = String(keyId || "").trim();
	if (!id) return { ok: true };

	const windowMs = 60_000;
	const existing = buckets.get(id);
	if (!existing || existing.resetAt <= nowMs) {
		buckets.set(id, { count: 1, resetAt: nowMs + windowMs });
		return { ok: true };
	}
	if (existing.count >= limit) {
		const retryAfterSeconds = Math.max(
			1,
			Math.ceil((existing.resetAt - nowMs) / 1000),
		);
		return { ok: false, retryAfterSeconds };
	}
	existing.count += 1;
	return { ok: true };
}

/** Test helper — clears in-memory buckets. */
export function resetPublicApiRateLimitBuckets() {
	buckets.clear();
}
