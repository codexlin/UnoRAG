import type { QdrantClient, Schemas } from "@qdrant/js-client-rest";

export const QDRANT_DENSE_VECTOR = "dense";
export const QDRANT_SPARSE_VECTOR = "sparse_v1";

export type QdrantVectorSchema = {
	denseVectorName: string | null;
	sparseVectorName: typeof QDRANT_SPARSE_VECTOR | null;
};

export const qdrantDistances = [
	"Cosine",
	"Euclid",
	"Dot",
	"Manhattan",
] as const;

export type QdrantDistance = (typeof qdrantDistances)[number];

export const UNORAG_QDRANT_PAYLOAD_INDEXES = [
	{ fieldName: "tenant_id", fieldSchema: { type: "keyword", is_tenant: true } },
	{ fieldName: "workspace_id", fieldSchema: "keyword" },
	{ fieldName: "library_id", fieldSchema: "keyword" },
	{ fieldName: "doc_id", fieldSchema: "keyword" },
	{ fieldName: "document_version_id", fieldSchema: "keyword" },
	{ fieldName: "generation_id", fieldSchema: "keyword" },
	{ fieldName: "lifecycle_visibility", fieldSchema: "keyword" },
	{ fieldName: "acl_scope", fieldSchema: "keyword" },
	{ fieldName: "acl_principal_ids", fieldSchema: "keyword" },
	{ fieldName: "acl_group_ids", fieldSchema: "keyword" },
	{ fieldName: "record_type", fieldSchema: "keyword" },
	{ fieldName: "record_id", fieldSchema: "keyword" },
	{ fieldName: "table_id", fieldSchema: "keyword" },
] as const satisfies ReadonlyArray<{
	fieldName: string;
	fieldSchema: Schemas["PayloadFieldSchema"];
}>;

type CollectionInfo = Awaited<ReturnType<QdrantClient["getCollection"]>>;
type DenseVectorConfig = NonNullable<
	CollectionInfo["config"]["params"]["vectors"]
>;

function isUnnamedDenseVector(
	config: DenseVectorConfig,
): config is Schemas["VectorParams"] {
	return typeof config.size === "number";
}

export type QdrantCollectionClient = Pick<
	QdrantClient,
	| "collectionExists"
	| "createCollection"
	| "createPayloadIndex"
	| "getCollection"
>;

export type QdrantCollectionContract = {
	collection: string;
	vectorSize: number;
	distance: QdrantDistance;
	/**
	 * True (default) when the embedding provider emits neural sparse vectors
	 * (e.g. DashScope qwen3.7-text-embedding dense&sparse), requiring `sparse_v1`
	 * with `modifier: "none"`. False for dense-only providers such as Ollama
	 * `bge-m3` or standard OpenAI-compatible embeddings.
	 */
	expectSparse?: boolean;
};

export type QdrantCollectionEnsureResult = QdrantCollectionContract & {
	vectorSchema: QdrantVectorSchema;
	created: boolean;
	createdPayloadIndexes: string[];
};

export class QdrantCollectionContractError extends Error {
	readonly code: string = "qdrant_schema_mismatch";
	readonly recovery: string =
		"Check the Qdrant dense vector, dimensions, distance, sparse_v1 (modifier: none) configuration and payload indexes. Restore the expected collection or reindex into a new collection.";

	constructor(message: string) {
		super(message);
		this.name = "QdrantCollectionContractError";
	}
}

export class QdrantEmbeddingDimensionMismatchError extends QdrantCollectionContractError {
	override readonly code = "embedding_dimension_mismatch";
	readonly collection: string;
	override readonly recovery: string;

	constructor(
		collection: string,
		readonly expectedDimension: number,
		readonly actualDimension: number,
	) {
		const safeCollection = /^[\w.-]{1,200}$/.test(collection)
			? collection
			: "QDRANT_COLLECTION";
		const recovery = `If your embedding model supports ${actualDimension} dimensions, set EMBEDDING_DIM=${actualDimension}. To use ${expectedDimension} dimensions, set QDRANT_COLLECTION to a new collection and reindex.`;
		super(
			`Qdrant collection ${safeCollection} vector size mismatch: configured EMBEDDING_DIM=${expectedDimension}, collection dense size=${actualDimension}. ${recovery}`,
		);
		this.collection = safeCollection;
		this.recovery = recovery;
	}
}

export class QdrantCollectionMissingError extends QdrantCollectionContractError {
	override readonly code = "qdrant_collection_missing";
	override readonly recovery =
		"Confirm PostgreSQL has no active documents before initializing an empty collection. Otherwise restore the indexed collection or reindex the active documents.";

	constructor() {
		super(
			"Qdrant collection is missing and an empty metadata instance was not confirmed",
		);
		this.name = "QdrantCollectionMissingError";
	}
}

export class QdrantIndexMissingError extends QdrantCollectionContractError {
	override readonly code = "qdrant_index_missing";
	override readonly recovery =
		"Confirm PostgreSQL has no active documents before using an empty index. Otherwise restore the indexed collection or reindex the active documents.";

	constructor() {
		super(
			"Qdrant collection has no points and an empty metadata instance was not confirmed",
		);
		this.name = "QdrantIndexMissingError";
	}
}

export class QdrantCollectionManager {
	private ensurePromise?: Promise<QdrantCollectionEnsureResult>;

	constructor(
		private readonly client: QdrantCollectionClient,
		private readonly contract: QdrantCollectionContract,
		private readonly options: { requireNew?: boolean } = {},
	) {
		validateContract(contract);
	}

	ensure(): Promise<QdrantCollectionEnsureResult> {
		if (!this.ensurePromise) {
			this.ensurePromise = this.ensureInternal().catch((error) => {
				this.ensurePromise = undefined;
				throw error;
			});
		}
		return this.ensurePromise;
	}

	private async ensureInternal(): Promise<QdrantCollectionEnsureResult> {
		const created = await this.ensureCollectionExists();
		if (this.options.requireNew && !created) {
			throw new QdrantCollectionContractError(
				"Target collection already exists; refusing to modify it",
			);
		}
		let info = await this.client.getCollection(this.contract.collection);
		validateCollectionInfo(info, this.contract);

		const createdPayloadIndexes: string[] = [];
		for (const index of UNORAG_QDRANT_PAYLOAD_INDEXES) {
			const existing = info.payload_schema[index.fieldName];
			if (existing) {
				assertPayloadIndexType(index.fieldName, existing.data_type);
				continue;
			}
			if (await this.createPayloadIndex(index.fieldName, index.fieldSchema)) {
				createdPayloadIndexes.push(index.fieldName);
			}
			info = await this.client.getCollection(this.contract.collection);
			validateCollectionInfo(info, this.contract);
			assertPayloadIndexType(
				index.fieldName,
				info.payload_schema[index.fieldName]?.data_type,
			);
		}

		return {
			...this.contract,
			vectorSchema: assertQdrantCollectionSchema(info, this.contract),
			created,
			createdPayloadIndexes,
		};
	}

	private async ensureCollectionExists(): Promise<boolean> {
		const existing = await this.client.collectionExists(
			this.contract.collection,
		);
		if (existing.exists) return false;
		const expectSparse = this.contract.expectSparse ?? true;
		try {
			const created = await this.client.createCollection(
				this.contract.collection,
				{
					vectors: {
						[QDRANT_DENSE_VECTOR]: {
							size: this.contract.vectorSize,
							distance: this.contract.distance,
						},
					},
					...(expectSparse
						? {
								sparse_vectors: {
									[QDRANT_SPARSE_VECTOR]: { modifier: "none" },
								},
							}
						: {}),
				},
			);
			if (!created) {
				throw new QdrantCollectionContractError(
					`Qdrant did not create collection ${this.contract.collection}`,
				);
			}
			return true;
		} catch (error) {
			// Another process may have won the create race. Only suppress the
			// failure when the authoritative collection now exists.
			const afterFailure = await this.client.collectionExists(
				this.contract.collection,
			);
			if (!afterFailure.exists) throw error;
			return false;
		}
	}

	private async createPayloadIndex(
		fieldName: string,
		fieldSchema: Schemas["PayloadFieldSchema"],
	): Promise<boolean> {
		try {
			await this.client.createPayloadIndex(this.contract.collection, {
				field_name: fieldName,
				field_schema: fieldSchema,
				wait: true,
				ordering: "strong",
			});
			return true;
		} catch (error) {
			// Index creation is also raced by every production process. A
			// concurrent compatible index is success; any other failure is not.
			const info = await this.client.getCollection(this.contract.collection);
			const existing = info.payload_schema[fieldName];
			if (!existing) throw error;
			assertPayloadIndexType(fieldName, existing.data_type);
			return false;
		}
	}
}

export function parseQdrantDistance(
	value: string | undefined,
	fallback: QdrantDistance = "Cosine",
): QdrantDistance {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return fallback;
	const distance = qdrantDistances.find(
		(candidate) => candidate.toLowerCase() === normalized,
	);
	if (!distance) {
		throw new QdrantCollectionContractError(
			`Qdrant distance must be one of ${qdrantDistances.join(", ")}`,
		);
	}
	return distance;
}

function validateContract(contract: QdrantCollectionContract): void {
	if (!contract.collection.trim()) {
		throw new QdrantCollectionContractError(
			"Qdrant collection name is required",
		);
	}
	if (!Number.isInteger(contract.vectorSize) || contract.vectorSize <= 0) {
		throw new QdrantCollectionContractError(
			"Qdrant vector size must be a positive integer",
		);
	}
	if (!qdrantDistances.includes(contract.distance)) {
		throw new QdrantCollectionContractError(
			`Unsupported Qdrant distance ${contract.distance}`,
		);
	}
}

export function detectQdrantVectorSchema(
	info: CollectionInfo,
	options: { expectSparse?: boolean } = {},
): QdrantVectorSchema {
	const vectors = info.config.params.vectors;
	if (
		!vectors ||
		(!isUnnamedDenseVector(vectors) && !vectors[QDRANT_DENSE_VECTOR])
	) {
		throw new QdrantCollectionContractError(
			"Qdrant collection has no supported dense vector",
		);
	}
	const expectSparse = options.expectSparse ?? true;
	const sparse = info.config.params.sparse_vectors?.[QDRANT_SPARSE_VECTOR];
	// Provider-native neural sparse vectors (ADR-0009) already encode learned term
	// importance and must not apply Qdrant's collection-level IDF modifier.
	if (sparse?.modifier === "idf") {
		throw new QdrantCollectionContractError(
			"Qdrant collection sparse_v1 must use modifier: none (not idf)",
		);
	}
	if (expectSparse && !sparse) {
		throw new QdrantCollectionContractError(
			"Qdrant collection must configure sparse_v1 with modifier: none; reindex into a new collection when migrating from dense-only or legacy lexical_v1 schemas",
		);
	}
	return {
		denseVectorName: isUnnamedDenseVector(vectors) ? null : QDRANT_DENSE_VECTOR,
		sparseVectorName: expectSparse ? QDRANT_SPARSE_VECTOR : null,
	};
}

export function assertQdrantEmbeddingDimension(
	info: CollectionInfo,
	contract: Pick<QdrantCollectionContract, "collection" | "vectorSize">,
): Schemas["VectorParams"] {
	const config = info.config.params.vectors;
	const vectors =
		config &&
		(isUnnamedDenseVector(config) ? config : config[QDRANT_DENSE_VECTOR]);
	if (!vectors || typeof vectors.size !== "number") {
		throw new QdrantCollectionContractError(
			`Qdrant collection ${contract.collection} must use one unnamed dense vector or a named dense vector`,
		);
	}
	if (vectors.size !== contract.vectorSize) {
		throw new QdrantEmbeddingDimensionMismatchError(
			contract.collection,
			contract.vectorSize,
			vectors.size,
		);
	}
	return vectors;
}

function validateCollectionInfo(
	info: CollectionInfo,
	contract: QdrantCollectionContract,
): void {
	if (!info?.config?.params) {
		throw new QdrantCollectionContractError(
			"Qdrant collection schema is missing",
		);
	}
	const vectors = assertQdrantEmbeddingDimension(info, contract);
	detectQdrantVectorSchema(info, { expectSparse: contract.expectSparse });
	if (vectors.distance !== contract.distance) {
		throw new QdrantCollectionContractError(
			`Qdrant collection ${contract.collection} distance mismatch: expected ${contract.distance}, received ${vectors.distance}`,
		);
	}
}

/** Read-only contract shared by initialized collections and readiness probes. */
export function assertQdrantCollectionSchema(
	info: CollectionInfo,
	contract: QdrantCollectionContract,
): QdrantVectorSchema {
	validateContract(contract);
	validateCollectionInfo(info, contract);
	for (const index of UNORAG_QDRANT_PAYLOAD_INDEXES) {
		assertPayloadIndexType(
			index.fieldName,
			info.payload_schema?.[index.fieldName]?.data_type,
		);
	}
	return detectQdrantVectorSchema(info, {
		expectSparse: contract.expectSparse,
	});
}

function assertPayloadIndexType(
	fieldName: string,
	dataType: Schemas["PayloadSchemaType"] | undefined,
): void {
	if (dataType !== "keyword") {
		throw new QdrantCollectionContractError(
			`Qdrant payload index ${fieldName} must be keyword, received ${dataType ?? "missing"}`,
		);
	}
}
