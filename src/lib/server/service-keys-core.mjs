import { createHash, randomBytes } from "node:crypto";

export const SERVICE_KEY_SCOPES = ["ask", "retrieve"];
export const KEY_PREFIX = "mk_svc_";
const KEY_SECRET_BYTES = 24;
const LIBRARY_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;

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
	const scopes = Array.from(input, (item) =>
		typeof item === "string" ? item.trim() : "",
	);
	if (scopes.some((scope) => !SERVICE_KEY_SCOPES.includes(scope))) return null;
	return [...new Set(scopes)];
}

export function normalizeLibraryIds(input) {
	// Explicit null is the persisted workspace-wide grant.
	if (input === null) return null;
	if (!Array.isArray(input) || input.length === 0) return undefined;
	const ids = Array.from(input, (item) =>
		typeof item === "string" ? item.trim() : "",
	);
	if (ids.some((id) => !LIBRARY_ID_PATTERN.test(id))) return undefined;
	return [...new Set(ids)];
}

export function serviceKeyHasScope(key, scope) {
	return normalizeScopes(key?.scopes)?.includes(scope) ?? false;
}

export function serviceKeyAllowsLibrary(key, libraryId) {
	if (key?.libraryIds === null) return true;
	return normalizeLibraryIds(key?.libraryIds)?.includes(libraryId) ?? false;
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
