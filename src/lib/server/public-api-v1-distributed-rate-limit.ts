import "server-only";

import { publicApiRateLimitPerMinute } from "./public-api-v1-rate-limit.mjs";
import { consumeFixedWindow } from "./security/fixed-window-rate-limit";

export async function checkPublicApiRateLimit(keyId: string) {
	const limit = publicApiRateLimitPerMinute();
	if (!limit) return { ok: true as const, remaining: Number.MAX_SAFE_INTEGER };
	return consumeFixedWindow({
		namespace: "public-api-key",
		subject: keyId,
		limit,
		windowSeconds: 60,
	});
}
