const WORKSPACE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function slugify(value) {
	return value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 128);
}

/**
 * @param {unknown} raw
 * @param {string} fallbackSlug
 * @returns {{ok: true, value: {name: string, slug: string, description: string | null}} | {ok: false, status: number, detail: string}}
 */
export function validateWorkspaceCreateInput(raw, fallbackSlug) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, status: 400, detail: "body must be an object" };
	}
	const name = typeof raw.name === "string" ? raw.name.trim() : "";
	if (!name) {
		return { ok: false, status: 400, detail: "name is required" };
	}
	if (name.length > 256) {
		return {
			ok: false,
			status: 400,
			detail: "name must be at most 256 characters",
		};
	}

	const requestedSlug = typeof raw.slug === "string" ? raw.slug.trim() : "";
	const slug = requestedSlug.toLowerCase() || slugify(name) || fallbackSlug;
	if (!WORKSPACE_SLUG_PATTERN.test(slug)) {
		return {
			ok: false,
			status: 400,
			detail:
				"slug must be 1-128 lowercase letters, numbers, or hyphens and cannot start or end with a hyphen",
		};
	}

	if (
		raw.description !== undefined &&
		raw.description !== null &&
		typeof raw.description !== "string"
	) {
		return {
			ok: false,
			status: 400,
			detail: "description must be a string or null",
		};
	}
	const description =
		typeof raw.description === "string" ? raw.description.trim() || null : null;
	if (description && description.length > 2000) {
		return {
			ok: false,
			status: 400,
			detail: "description must be at most 2000 characters",
		};
	}

	return { ok: true, value: { name, slug, description } };
}

/**
 * @param {unknown} value
 * @returns {{ok: true, value: string} | {ok: false, status: number, detail: string}}
 */
export function validateWorkspaceId(value) {
	if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
		return {
			ok: false,
			status: 400,
			detail: "workspace_id must be a UUID",
		};
	}
	return { ok: true, value: value.trim().toLowerCase() };
}

/**
 * @param {unknown} value
 * @returns {{ok: true, value: string} | {ok: false, status: number, detail: string}}
 */
export function validateWorkspaceIdempotencyKey(value) {
	const result = validateWorkspaceId(value);
	if (!result.ok) {
		return {
			ok: false,
			status: 400,
			detail: "Idempotency-Key must be a UUID",
		};
	}
	return result;
}
