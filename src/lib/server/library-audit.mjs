import { randomUUID } from "node:crypto";

function boundedHeader(request, name, maxLength) {
	const value = request.headers.get(name)?.trim();
	return value ? value.slice(0, maxLength) : null;
}

export function libraryAuditRequestContext(request) {
	const forwardedFor = boundedHeader(request, "x-forwarded-for", 512);
	return {
		requestId: boundedHeader(request, "x-request-id", 128) ?? randomUUID(),
		ipAddress:
			forwardedFor?.split(",")[0]?.trim().slice(0, 64) ||
			boundedHeader(request, "x-real-ip", 64),
		userAgent: boundedHeader(request, "user-agent", 2_000),
	};
}

export function libraryCreatedAuditDetails(library) {
	return {
		library_id: library.ragLibraryId,
		name: library.name,
		status: library.status,
		document_profile: library.documentProfile,
		scan_handling: library.scanHandling,
		parse_preference: library.parsePreference,
		ingest_policy_version: library.ingestPolicyVersion,
	};
}

export function libraryUpdatedAuditDetails(before, after) {
	const changedFields = [];
	const changes = {};
	const record = (field, from, to) => {
		if (from === to) return;
		changedFields.push(field);
		changes[field] = { from, to };
	};

	record("name", before.name, after.name);
	if ((before.description ?? null) !== (after.description ?? null)) {
		changedFields.push("description");
		changes.description = { changed: true };
	}
	record("document_profile", before.documentProfile, after.documentProfile);
	record("scan_handling", before.scanHandling, after.scanHandling);
	record("parse_preference", before.parsePreference, after.parsePreference);

	return {
		library_id: after.ragLibraryId,
		name: after.name,
		status: after.status,
		changed_fields: changedFields,
		changes,
		policy_changed: changedFields.some((field) =>
			["document_profile", "scan_handling", "parse_preference"].includes(field),
		),
		ingest_policy_version: after.ingestPolicyVersion,
	};
}

export function libraryDeleteRequestedAuditDetails(library, outcome) {
	return {
		library_id: library.ragLibraryId,
		name: library.name,
		status: outcome.immediate ? "deleted" : "deleting",
		document_count: outcome.documentCount,
		delete_job_count: outcome.queuedJobs,
		immediate: outcome.immediate,
	};
}
