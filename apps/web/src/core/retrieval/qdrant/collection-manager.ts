import type { QdrantClient, Schemas } from "@qdrant/js-client-rest";

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
};

export type QdrantCollectionEnsureResult = QdrantCollectionContract & {
	created: boolean;
	createdPayloadIndexes: string[];
};

export class QdrantCollectionContractError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "QdrantCollectionContractError";
	}
}

export class QdrantCollectionManager {
	private ensurePromise?: Promise<QdrantCollectionEnsureResult>;

	constructor(
		private readonly client: QdrantCollectionClient,
		private readonly contract: QdrantCollectionContract,
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
			created,
			createdPayloadIndexes,
		};
	}

	private async ensureCollectionExists(): Promise<boolean> {
		const existing = await this.client.collectionExists(
			this.contract.collection,
		);
		if (existing.exists) return false;
		try {
			const created = await this.client.createCollection(
				this.contract.collection,
				{
					vectors: {
						size: this.contract.vectorSize,
						distance: this.contract.distance,
					},
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

function validateCollectionInfo(
	info: CollectionInfo,
	contract: QdrantCollectionContract,
): void {
	const vectors = info.config.params.vectors;
	if (!vectors || !("size" in vectors)) {
		throw new QdrantCollectionContractError(
			`Qdrant collection ${contract.collection} must use one unnamed dense vector`,
		);
	}
	if (vectors.size !== contract.vectorSize) {
		throw new QdrantCollectionContractError(
			`Qdrant collection ${contract.collection} vector size mismatch: expected ${contract.vectorSize}, received ${vectors.size}`,
		);
	}
	if (vectors.distance !== contract.distance) {
		throw new QdrantCollectionContractError(
			`Qdrant collection ${contract.collection} distance mismatch: expected ${contract.distance}, received ${vectors.distance}`,
		);
	}
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
