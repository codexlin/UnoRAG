#!/usr/bin/env tsx

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { QdrantClient, type Schemas } from "@qdrant/js-client-rest";
import { sparseVector } from "../src/core/retrieval/hybrid/sparse-vector";
import {
	assertQdrantEmbeddingDimension,
	parseQdrantDistance,
	QDRANT_DENSE_VECTOR,
	QDRANT_SPARSE_VECTOR,
	QdrantCollectionManager,
} from "../src/core/retrieval/qdrant/collection-manager";

type QdrantPoint = Schemas["PointStruct"];
type SourcePoint = {
	id: string | number;
	payload?: Record<string, unknown> | null;
	vector?: unknown;
};

function argValue(args: readonly string[], flag: string): string | null {
	const index = args.indexOf(flag);
	return index >= 0 ? (args[index + 1] ?? null) : null;
}

function stringField(
	payload: Record<string, unknown>,
	key: string,
): string {
	const value = payload[key];
	return typeof value === "string" ? value.trim() : "";
}

/**
 * Reconstruct the lexical indexing text from a stored Qdrant point payload.
 * Mirrors the runtime lexical fallback in retrieval-service without re-calling any model.
 */
export function indexedLexicalText(payload: Record<string, unknown>): string {
	const base =
		stringField(payload, "body") ||
		stringField(payload, "text") ||
		"";
	const recordType = stringField(payload, "record_type") || "chunk";
	const contextual = stringField(payload, "contextual_prefix");
	const hasEmbeddedAsset =
		Boolean(stringField(payload, "table_id")) ||
		Boolean(stringField(payload, "figure_id"));
	const splitStrategy = stringField(payload, "split_strategy");
	if (
		recordType === "chunk" &&
		!hasEmbeddedAsset &&
		splitStrategy !== "code" &&
		contextual &&
		!base.startsWith(contextual)
	) {
		return `${contextual}\n${base}`.trim();
	}
	return base;
}

export function extractDenseVector(rawVector: unknown): number[] {
	if (Array.isArray(rawVector) && rawVector.every((v) => typeof v === "number")) {
		return rawVector;
	}
	if (rawVector && typeof rawVector === "object" && !Array.isArray(rawVector)) {
		const record = rawVector as Record<string, unknown>;
		const named = record[QDRANT_DENSE_VECTOR] ?? record[""];
		if (Array.isArray(named) && named.every((v) => typeof v === "number")) {
			return named;
		}
	}
	throw new Error("Qdrant point is missing a dense numeric vector");
}

export function buildSparseBackfillPoint(point: SourcePoint): QdrantPoint {
	const payload = point.payload ?? {};
	const dense = extractDenseVector(point.vector);
	const lexicalText = indexedLexicalText(payload);
	const sparse = sparseVector(lexicalText);
	return {
		id: point.id,
		vector: {
			[QDRANT_DENSE_VECTOR]: dense,
			// Qdrant requires at least one entry in a sparse vector map when omitted vs empty;
			// skip empty sparse weights gracefully while keeping dense intact.
			...(sparse.indices.length > 0 ? { [QDRANT_SPARSE_VECTOR]: sparse } : {}),
		},
		payload,
	};
}

async function run(): Promise<void> {
	const args = process.argv.slice(2);
	if (!args.includes("--execute")) {
		throw new Error("Backfill writes a new collection; pass --execute and an explicit unused --to name");
	}
	const qdrantUrl =
		argValue(args, "--qdrant-url") ??
		process.env.QDRANT_URL?.trim() ??
		"http://127.0.0.1:6333";
	const fromCollection =
		argValue(args, "--from") ??
		process.env.QDRANT_COLLECTION?.trim() ??
		"unorag_chunks";
	const toCollection = argValue(args, "--to")?.trim();
	const dimensions = Number(
		argValue(args, "--dimensions") ?? process.env.EMBEDDING_DIM ?? 1024,
	);
	const batchSize = Number(argValue(args, "--batch-size") ?? 128);
	if (!toCollection || fromCollection === toCollection) {
		throw new Error("--to must name a new collection distinct from --from");
	}
	if (
		!Number.isSafeInteger(dimensions) ||
		dimensions < 1 ||
		!Number.isSafeInteger(batchSize) ||
		batchSize < 1 ||
		batchSize > 512
	) {
		throw new Error("Expected positive integer dimensions and --batch-size between 1 and 512");
	}

	const client = new QdrantClient({
		url: qdrantUrl,
		apiKey: process.env.QDRANT_API_KEY?.trim() || undefined,
		timeout: 30_000,
		checkCompatibility: true,
	});

	const distance = parseQdrantDistance(process.env.QDRANT_DISTANCE);
	const sourceInfo = await client.getCollection(fromCollection);
	const sourceDense = assertQdrantEmbeddingDimension(sourceInfo, {
		collection: fromCollection,
		vectorSize: dimensions,
	});
	if (sourceDense.distance !== distance) {
		throw new Error(
			`Source collection uses ${sourceDense.distance} distance; set QDRANT_DISTANCE to match before backfill`,
		);
	}
	const { count: sourceCount } = await client.count(fromCollection, {
		exact: true,
	});
	process.stdout.write(
		`== source ${fromCollection}: ${sourceCount} points (qdrant=${qdrantUrl})\n`,
	);

	const ensured = await new QdrantCollectionManager(
		client,
		{ collection: toCollection, vectorSize: dimensions, distance },
		{ requireNew: true },
	).ensure();
	process.stdout.write(
		`== target ${toCollection}: created=${ensured.created} schema=${JSON.stringify(ensured.vectorSchema)}\n`,
	);

	let offset: string | number | Record<string, unknown> | undefined;
	let copied = 0;
	while (true) {
		const page = await client.scroll(fromCollection, {
			limit: batchSize,
			...(offset === undefined ? {} : { offset }),
			with_payload: true,
			with_vector: true,
		});
		if (page.points.length === 0) break;
		const points = page.points.map((point) =>
			buildSparseBackfillPoint(point as SourcePoint),
		);
		const result = await client.upsert(toCollection, {
			wait: true,
			ordering: "strong",
			points,
		});
		if (result.status !== "completed") {
			throw new Error(`Qdrant upsert returned ${result.status}`);
		}
		const stored = await client.retrieve(toCollection, {
			ids: points.map((point) => point.id),
			with_payload: true,
			with_vector: false,
		});
		const storedPayloads = new Map(
			stored.map((point) => [String(point.id), point.payload ?? {}]),
		);
		if (
			stored.length !== points.length ||
			points.some(
				(point) =>
					!isDeepStrictEqual(storedPayloads.get(String(point.id)), point.payload),
			)
		) {
			throw new Error(
				"Target collection point IDs or payloads do not match the source batch",
			);
		}
		copied += points.length;
		process.stdout.write(`  copied ${copied}/${sourceCount}\n`);
		const next = page.next_page_offset;
		if (next === null || next === undefined) break;
		if (typeof next !== "string" && typeof next !== "number") {
			throw new Error("Unsupported Qdrant scroll offset");
		}
		offset = next;
	}

	const [{ count: currentSourceCount }, { count: targetCount }] =
		await Promise.all([
			client.count(fromCollection, { exact: true }),
			client.count(toCollection, { exact: true }),
		]);
	if (
		currentSourceCount !== sourceCount ||
		targetCount !== sourceCount ||
		copied !== sourceCount
	) {
		throw new Error(
			`Point count mismatch after backfill: expected=${sourceCount}, source=${currentSourceCount}, copied=${copied}, target=${targetCount}`,
		);
	}
	process.stdout.write(
		`== verified ${targetCount}/${sourceCount} points in ${toCollection} with local lexical_v1 sparse vectors ($0 API cost)\n`,
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	void run().catch((error) => {
		const detail =
			error instanceof Error ? (error.stack ?? error.message) : String(error);
		process.stderr.write(`FAIL: ${detail}\n`);
		process.exitCode = 1;
	});
}
