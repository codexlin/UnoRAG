import {
	type QdrantCondition,
	type QdrantFieldCondition,
	type QdrantFilter,
	QdrantFilterSchema,
	type RetrievalScope,
	RetrievalScopeSchema,
	type RetrievalUserFilters,
	RetrievalUserFiltersSchema,
} from "../contracts";

export const NO_ACTIVE_GENERATION_SENTINELS = [
	"__unorag_no_active_generation_a__",
	"__unorag_no_active_generation_b__",
] as const;
export const NO_ALLOWED_DOCUMENT_SENTINELS = [
	"__unorag_no_allowed_document_a__",
	"__unorag_no_allowed_document_b__",
] as const;

function matchValue(key: string, value: string): QdrantFieldCondition {
	return { key, match: { value } };
}

function matchAny(key: string, values: string[]): QdrantFieldCondition {
	return { key, match: { any: values } };
}

function lifecycleCondition(): QdrantFilter {
	return {
		should: [
			matchValue("lifecycle_visibility", "active"),
			{ is_empty: { key: "lifecycle_visibility" } },
		],
	};
}

function generationCondition(activeGenerationIds: string[]): QdrantFilter {
	if (activeGenerationIds.length > 0) {
		return {
			must: [matchAny("generation_id", activeGenerationIds)],
		};
	}

	// Contradictory exact matches are portable across Qdrant versions and avoid
	// relying on the implementation-defined behavior of an empty MatchAny.
	return {
		must: NO_ACTIVE_GENERATION_SENTINELS.map((value) =>
			matchValue("generation_id", value),
		),
	};
}

function aclCondition(scope: RetrievalScope): QdrantFilter {
	const should: QdrantCondition[] = [
		matchValue("acl_scope", "workspace"),
		matchAny("acl_principal_ids", scope.principalIds),
	];
	if (scope.groupIds.length > 0) {
		should.push(matchAny("acl_group_ids", scope.groupIds));
	}
	return { should };
}

function recordTypeCondition(
	recordType: RetrievalUserFilters["record_type"],
): QdrantCondition | null {
	if (!recordType) return null;
	if (recordType === "chunk") {
		return {
			should: [
				matchValue("record_type", "chunk"),
				{ is_null: { key: "record_type" } },
			],
		};
	}
	if (recordType === "chunk+table_summary") {
		return {
			should: [
				matchValue("record_type", "chunk"),
				matchValue("record_type", "table_summary"),
				{ is_null: { key: "record_type" } },
			],
		};
	}
	return matchValue("record_type", recordType);
}

export function buildMandatoryQdrantFilter(input: {
	scope: RetrievalScope;
	userFilters?: RetrievalUserFilters | unknown;
}): QdrantFilter {
	const scope = RetrievalScopeSchema.parse(input.scope);
	const userFilters = RetrievalUserFiltersSchema.parse(input.userFilters ?? {});
	const must: QdrantCondition[] = [
		matchValue("tenant_id", scope.tenantId),
		matchValue("workspace_id", scope.workspaceId),
		aclCondition(scope),
		lifecycleCondition(),
		generationCondition(scope.activeGenerationIds),
		matchValue("library_id", scope.libraryId),
	];
	if (scope.documentIds) {
		if (scope.documentIds.length) {
			must.push(matchAny("doc_id", scope.documentIds));
		} else {
			must.push(
				...NO_ALLOWED_DOCUMENT_SENTINELS.map((value) =>
					matchValue("doc_id", value),
				),
			);
		}
	}

	const recordType = recordTypeCondition(userFilters.record_type);
	if (recordType) must.push(recordType);
	for (const key of ["doc_id", "table_id", "document_version_id"] as const) {
		const value = userFilters[key];
		if (value) must.push(matchValue(key, value));
	}

	return QdrantFilterSchema.parse({ must });
}
