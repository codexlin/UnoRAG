/**
 * Document ACL control-plane helpers.
 *
 * Storage: app.document_acl (subject_type principal|group, permission read).
 * Empty rows ⇒ workspace scope (all workspace members see the doc in Ask).
 * Non-empty ⇒ restricted (Qdrant acl_scope=restricted; ingest projects lists).
 *
 * subject_type must be "principal" (ingest job_repository filter), not "user".
 */

import { canWriteLibraries } from "./library-permissions.mjs";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function authorizeDocumentAclWrite(identity) {
	if (!identity) {
		return { ok: false, status: 401, detail: "authentication required" };
	}
	if (!canWriteLibraries(identity)) {
		return {
			ok: false,
			status: 403,
			detail: "library write permission required",
		};
	}
	return { ok: true };
}

export function authorizeDocumentAclRead(identity) {
	if (!identity) {
		return { ok: false, status: 401, detail: "authentication required" };
	}
	// Any workspace member who can open the library may view ACL summary.
	return { ok: true };
}

export function isUuid(value) {
	return typeof value === "string" && UUID_RE.test(value.trim());
}

/**
 * @param {unknown} body
 * @returns {{
 *   ok: true,
 *   scope: "workspace" | "restricted",
 *   principalIds: string[],
 *   groupIds: string[],
 * } | { ok: false, status: number, detail: string }}
 */
export function parseDocumentAclBody(body) {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, status: 400, detail: "invalid JSON body" };
	}
	const scopeRaw = String(body.scope ?? "")
		.trim()
		.toLowerCase();
	if (scopeRaw !== "workspace" && scopeRaw !== "restricted") {
		return {
			ok: false,
			status: 400,
			detail: "scope must be workspace or restricted",
		};
	}

	const principalIds = normalizeIdList(body.principal_ids ?? body.principals);
	const groupIds = normalizeIdList(body.group_ids ?? body.groups);

	if (principalIds === null || groupIds === null) {
		return {
			ok: false,
			status: 400,
			detail: "principal_ids and group_ids must be uuid arrays",
		};
	}

	if (scopeRaw === "workspace") {
		return {
			ok: true,
			scope: "workspace",
			principalIds: [],
			groupIds: [],
		};
	}

	if (principalIds.length === 0 && groupIds.length === 0) {
		return {
			ok: false,
			status: 400,
			detail: "restricted scope requires at least one principal or group",
		};
	}

	return {
		ok: true,
		scope: "restricted",
		principalIds,
		groupIds,
	};
}

function normalizeIdList(raw) {
	if (raw == null) return [];
	if (!Array.isArray(raw)) return null;
	const out = [];
	const seen = new Set();
	for (const item of raw) {
		if (typeof item === "object" && item && "id" in item) {
			const id = String(item.id).trim();
			if (!isUuid(id)) return null;
			if (!seen.has(id)) {
				seen.add(id);
				out.push(id);
			}
			continue;
		}
		const id = String(item ?? "").trim();
		if (!isUuid(id)) return null;
		if (!seen.has(id)) {
			seen.add(id);
			out.push(id);
		}
	}
	return out;
}

/**
 * @param {Array<{ subjectType: string, subjectId: string, permission?: string }>} rows
 */
export function toDocumentAclResponse(rows, memberById = new Map()) {
	const principals = [];
	const groups = [];
	for (const row of rows) {
		if (row.permission && row.permission !== "read") continue;
		const entry = {
			id: row.subjectId,
			label:
				memberById.get(row.subjectId)?.displayName ||
				memberById.get(row.subjectId)?.email ||
				row.subjectId,
			email: memberById.get(row.subjectId)?.email ?? null,
			role: memberById.get(row.subjectId)?.role ?? null,
		};
		if (row.subjectType === "principal" || row.subjectType === "user") {
			principals.push(entry);
		} else if (row.subjectType === "group") {
			groups.push(entry);
		}
	}
	const scope =
		principals.length === 0 && groups.length === 0 ? "workspace" : "restricted";
	return {
		scope,
		principals,
		groups,
		principal_ids: principals.map((item) => item.id),
		group_ids: groups.map((item) => item.id),
	};
}

/**
 * Decide how ACL changes reach the Ask data plane.
 * Ready docs with a stored source → reindex (existing ingest ACL projection).
 */
export function resolveAclProjection(document) {
	if (!document) return "none";
	if (document.status === "deleted" || document.status === "deleting") {
		return "none";
	}
	if (document.status === "processing") {
		return "deferred_to_ingest";
	}
	if (
		(document.status === "ready" || document.status === "degraded") &&
		document.hasStorageKey
	) {
		return "reindex_required";
	}
	return "control_plane_only";
}
