import { createHash } from "node:crypto";

import type { Schemas } from "@qdrant/js-client-rest";

import type { IndexWritePayload } from "./index-records";

type QdrantFilter = Schemas["Filter"];
type QdrantPoint = Schemas["PointStruct"];

export type IngestAclSnapshot = {
	scope: "workspace" | "restricted";
	principalIds: string[];
	groupIds: string[];
};

export type IngestPointScope = {
	organizationId: string;
	workspaceId: string;
	libraryId: string;
	documentId: string;
	documentVersionId: string;
	generationId: string;
	title: string;
	acl: IngestAclSnapshot;
};

export type AclProjectionScope = Pick<
	IngestPointScope,
	"organizationId" | "workspaceId" | "libraryId" | "documentId" | "generationId"
> & {
	acl: IngestAclSnapshot;
};

export interface QdrantIngestClient {
	upsert(
		collection: string,
		input: {
			wait: true;
			ordering: "strong";
			points: QdrantPoint[];
		},
	): Promise<{ status: Schemas["UpdateStatus"] }>;
	count(
		collection: string,
		input: {
			filter: QdrantFilter;
			exact: true;
		},
	): Promise<{ count: number }>;
	setPayload(
		collection: string,
		input: {
			payload: Record<string, unknown>;
			filter: QdrantFilter;
			wait: true;
			ordering: "strong";
		},
	): Promise<{ status: Schemas["UpdateStatus"] }>;
}

export class QdrantIngestWriteStore {
	private readonly batchSize: number;

	constructor(
		private readonly client: QdrantIngestClient,
		private readonly collection: string,
		options: { batchSize?: number } = {},
	) {
		if (!collection.trim()) throw new Error("Qdrant collection is required");
		this.batchSize = Math.max(1, Math.trunc(options.batchSize ?? 64));
	}

	async stage(input: {
		records: IndexWritePayload[];
		vectors: number[][];
		scope: IngestPointScope;
		beforeBatch?: () => Promise<void>;
	}): Promise<number> {
		validateScope(input.scope);
		if (input.records.length === 0) {
			throw new Error("cannot stage an empty document");
		}
		if (input.records.length !== input.vectors.length) {
			throw new Error("record and embedding counts do not match");
		}
		const dimensions = input.vectors[0]?.length ?? 0;
		if (dimensions === 0) throw new Error("embedding vectors are empty");

		const points = input.records.map((record, index): QdrantPoint => {
			const vector = input.vectors[index];
			if (
				!vector ||
				vector.length !== dimensions ||
				vector.some((value) => !Number.isFinite(value))
			) {
				throw new Error("embedding vector dimensions or values are invalid");
			}
			assertRecordScope(record, input.scope);
			return {
				id: record._point_id,
				vector,
				payload: storedPayload(record, input.scope),
			};
		});

		for (let offset = 0; offset < points.length; offset += this.batchSize) {
			await input.beforeBatch?.();
			const result = await this.client.upsert(this.collection, {
				wait: true,
				ordering: "strong",
				points: points.slice(offset, offset + this.batchSize),
			});
			if (result.status !== "completed") {
				throw new Error(`Qdrant upsert returned ${result.status}`);
			}
		}

		const stored = await this.client.count(this.collection, {
			filter: generationFilter(input.scope, "staging"),
			exact: true,
		});
		if (stored.count !== points.length) {
			throw new Error(
				`Qdrant generation count mismatch: expected ${points.length}, received ${stored.count}`,
			);
		}
		return stored.count;
	}

	async setVisibility(
		scope: IngestPointScope,
		visibility: "active" | "inactive",
	): Promise<number> {
		validateScope(scope);
		const result = await this.client.setPayload(this.collection, {
			payload: {
				lifecycle_visibility: visibility,
				...(visibility === "active"
					? {
							acl_scope: scope.acl.scope,
							acl_principal_ids:
								scope.acl.scope === "restricted"
									? [...scope.acl.principalIds]
									: [],
							acl_group_ids:
								scope.acl.scope === "restricted" ? [...scope.acl.groupIds] : [],
						}
					: {}),
				...(visibility === "inactive"
					? { deactivated_at: new Date().toISOString() }
					: {}),
			},
			filter: generationFilter(scope, undefined, false),
			wait: true,
			ordering: "strong",
		});
		if (result.status !== "completed") {
			throw new Error(`Qdrant setPayload returned ${result.status}`);
		}
		const updated = await this.client.count(this.collection, {
			filter: generationFilter(scope, visibility, false),
			exact: true,
		});
		if (updated.count === 0) {
			throw new Error(
				`Qdrant visibility update matched no points for generation ${scope.generationId}`,
			);
		}
		return updated.count;
	}

	async projectAcl(
		scope: AclProjectionScope,
		expectedPointCount: number,
	): Promise<number> {
		validateAclProjectionScope(scope);
		if (!Number.isInteger(expectedPointCount) || expectedPointCount <= 0) {
			throw new Error("expectedPointCount must be a positive integer");
		}
		const result = await this.client.setPayload(this.collection, {
			payload: {
				acl_scope: scope.acl.scope,
				acl_principal_ids:
					scope.acl.scope === "restricted" ? [...scope.acl.principalIds] : [],
				acl_group_ids:
					scope.acl.scope === "restricted" ? [...scope.acl.groupIds] : [],
			},
			filter: aclProjectionFilter(scope),
			wait: true,
			ordering: "strong",
		});
		if (result.status !== "completed") {
			throw new Error(`Qdrant setPayload returned ${result.status}`);
		}
		const updated = await this.client.count(this.collection, {
			filter: aclProjectionFilter(scope),
			exact: true,
		});
		if (updated.count !== expectedPointCount) {
			throw new Error(
				`Qdrant ACL projection count mismatch for generation ${scope.generationId}: expected ${expectedPointCount}, received ${updated.count}`,
			);
		}
		return updated.count;
	}
}

export function ingestAclFingerprint(acl: IngestAclSnapshot): string {
	const canonical = JSON.stringify({
		scope: acl.scope,
		principalIds:
			acl.scope === "restricted" ? [...new Set(acl.principalIds)].sort() : [],
		groupIds:
			acl.scope === "restricted" ? [...new Set(acl.groupIds)].sort() : [],
	});
	return createHash("sha256").update(canonical).digest("hex");
}

function storedPayload(
	record: IndexWritePayload,
	scope: IngestPointScope,
): Record<string, unknown> {
	const { _point_id, embed_text, ...content } = record;
	void _point_id;
	void embed_text;
	return {
		...content,
		library_id: scope.libraryId,
		doc_id: scope.documentId,
		title: scope.title,
		document_version_id: scope.documentVersionId,
		generation_id: scope.generationId,
		tenant_id: scope.organizationId,
		workspace_id: scope.workspaceId,
		lifecycle_visibility: "staging",
		acl_scope: scope.acl.scope,
		acl_principal_ids:
			scope.acl.scope === "restricted" ? [...scope.acl.principalIds] : [],
		acl_group_ids:
			scope.acl.scope === "restricted" ? [...scope.acl.groupIds] : [],
	};
}

function generationFilter(
	scope: IngestPointScope,
	visibility?: "staging" | "active" | "inactive",
	includeVersion = true,
): QdrantFilter {
	const must: NonNullable<QdrantFilter["must"]> = [
		match("tenant_id", scope.organizationId),
		match("workspace_id", scope.workspaceId),
		match("library_id", scope.libraryId),
		match("doc_id", scope.documentId),
		match("generation_id", scope.generationId),
	];
	if (includeVersion) {
		must.splice(4, 0, match("document_version_id", scope.documentVersionId));
	}
	if (visibility) must.push(match("lifecycle_visibility", visibility));
	return { must };
}

function aclProjectionFilter(scope: AclProjectionScope): QdrantFilter {
	return {
		must: [
			match("tenant_id", scope.organizationId),
			match("workspace_id", scope.workspaceId),
			match("library_id", scope.libraryId),
			match("doc_id", scope.documentId),
			match("generation_id", scope.generationId),
		],
	};
}

function match(key: string, value: string): Schemas["Condition"] {
	return { key, match: { value } };
}

function assertRecordScope(
	record: IndexWritePayload,
	scope: IngestPointScope,
): void {
	if (
		record.tenant_id !== scope.organizationId ||
		record.workspace_id !== scope.workspaceId ||
		record.document_version_id !== scope.documentVersionId ||
		record.generation_id !== scope.generationId ||
		record.lifecycle_visibility !== "staging"
	) {
		throw new Error("index record scope does not match authoritative scope");
	}
}

function validateScope(scope: IngestPointScope): void {
	for (const [name, value] of Object.entries({
		organizationId: scope.organizationId,
		workspaceId: scope.workspaceId,
		libraryId: scope.libraryId,
		documentId: scope.documentId,
		documentVersionId: scope.documentVersionId,
		generationId: scope.generationId,
		title: scope.title,
	})) {
		if (!value.trim()) throw new Error(`${name} is required`);
	}
	if (
		scope.acl.scope === "restricted" &&
		scope.acl.principalIds.length === 0 &&
		scope.acl.groupIds.length === 0
	) {
		throw new Error("restricted ACL requires a principal or group");
	}
}

function validateAclProjectionScope(scope: AclProjectionScope): void {
	for (const [name, value] of Object.entries({
		organizationId: scope.organizationId,
		workspaceId: scope.workspaceId,
		libraryId: scope.libraryId,
		documentId: scope.documentId,
		generationId: scope.generationId,
	})) {
		if (!value.trim()) throw new Error(`${name} is required`);
	}
	if (
		scope.acl.scope === "restricted" &&
		scope.acl.principalIds.length === 0 &&
		scope.acl.groupIds.length === 0
	) {
		throw new Error("restricted ACL requires a principal or group");
	}
}
