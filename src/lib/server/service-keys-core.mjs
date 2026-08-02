import { createHash, randomBytes } from "node:crypto";

export const SERVICE_KEY_SCOPES = ["ask", "retrieve"];
export const KEY_PREFIX = "mk_svc_";
const KEY_SECRET_BYTES = 24;

export function hashServiceKey(rawKey) {
	return createHash("sha256").update(rawKey, "utf8").digest("hex");
}

export function generateServiceKeyRaw() {
	const secret = randomBytes(KEY_SECRET_BYTES).toString("base64url");
	const rawKey = `${KEY_PREFIX}${secret}`;
	return { rawKey, prefix: rawKey.slice(0, 16) };
}

export function normalizeScopes(input) {
	if (!Array.isArray(input) || input.length === 0) return null;
	const scopes = [
		...new Set(
			input
				.map((item) => String(item).trim())
				.filter((item) => SERVICE_KEY_SCOPES.includes(item)),
		),
	];
	return scopes.length > 0 ? scopes : null;
}

export function normalizeLibraryIds(input) {
	if (input == null) return null;
	if (!Array.isArray(input)) return null;
	const ids = [
		...new Set(
			input
				.map((item) => String(item).trim())
				.filter((item) => item.length > 0 && item.length <= 128),
		),
	];
	return ids.length > 0 ? ids : null;
}

export function serviceKeyHasScope(key, scope) {
	return Array.isArray(key?.scopes) && key.scopes.includes(scope);
}

export function serviceKeyAllowsLibrary(key, libraryId) {
	if (!key?.libraryIds || key.libraryIds.length === 0) return true;
	return key.libraryIds.includes(libraryId);
}

export function extractBearerServiceKey(authorizationHeader, altHeader) {
	if (authorizationHeader) {
		const match = /^Bearer\s+(\S+)$/i.exec(String(authorizationHeader).trim());
		if (match?.[1]) return match[1];
	}
	const alt = altHeader?.trim?.() || String(altHeader || "").trim();
	return alt || null;
}

export function principalForServiceKey(keyId) {
	return `service:${keyId}`;
}
