import { createHash } from "node:crypto";
import { z } from "zod";

const identifier = z.string().regex(/^[a-zA-Z0-9_.:-]{1,160}$/);
const text = z.string().min(1).max(32_768).regex(/\S/);
const label = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const EvaluationBuildFingerprintSchema = z.strictObject({
	git_commit: z
		.string()
		.regex(/^[a-f0-9]{40}$/)
		.nullable(),
	git_dirty: z.boolean().nullable(),
	runtime_build_ref: label.nullable(),
	image_digest: label.nullable(),
	models: z.strictObject({
		chat: label.nullable(),
		judge: label.nullable(),
		embedding: label.nullable(),
		rerank: label.nullable(),
	}),
	prompts: z.record(
		z.string().regex(/^[a-z_]{1,64}$/),
		z.strictObject({ version: label, digest }),
	),
});

const retrievalSchema = z.strictObject({
	stage: z.literal("ask_base_retrieval"),
	complete: z.literal(true),
	ordered: z.literal(true),
	query: text,
	attempt: z.number().int().min(1).max(10),
});

export const CapturedAskRetrievalSchema = z.strictObject({
	schema_version: z.literal(1),
	run_id: identifier,
	case_id: identifier,
	request_id: identifier,
	question_sha256: digest,
	retrieved_contexts: z.array(text).max(50),
	retrieval: retrievalSchema,
});

const generationContexts = z
	.array(z.string().min(1).max(2_000_000).regex(/\S/))
	.max(51);

export const CapturedAskGenerationSchema = z.strictObject({
	schema_version: z.literal(1),
	run_id: identifier,
	case_id: identifier,
	request_id: identifier,
	question_sha256: digest,
	response_sha256: digest,
	generation_contexts: generationContexts,
});

export const RagasSampleSchema = z.strictObject({
	schema_version: z.literal(1),
	case_id: identifier,
	run_id: identifier,
	request_id: identifier,
	build_fingerprint: EvaluationBuildFingerprintSchema,
	question: text,
	response: text,
	context_scope: z.enum([
		"provided",
		"selected",
		"full_retrieval",
		"unavailable",
	]),
	retrieved_contexts: z.array(text).max(50),
	generation_contexts: generationContexts,
	response_sha256: digest.nullable(),
	provenance: z.strictObject({
		response: z.enum(["server_stream_sha256", "unverified"]),
		build_fingerprint: z.literal("unverified"),
		generation_context: z.enum([
			"server_model_input",
			"provided",
			"unavailable",
		]),
	}),
	reference: text.nullable(),
	retrieval: retrievalSchema.nullable(),
});

export type RagasSample = z.infer<typeof RagasSampleSchema>;

export function evaluationTextDigest(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

const liveReportSchema = z.object({
	run_id: identifier,
	build_fingerprint: EvaluationBuildFingerprintSchema,
	positive_cases: z
		.array(
			z.object({
				gold: z.object({ id: identifier, question: text, answer: text }),
				ingestStatus: z.literal("completed"),
				response: z.object({
					httpStatus: z.literal(200),
					answer: text,
					requestId: identifier,
					refused: z.literal(false),
					retrievalDebug: z
						.record(z.string(), z.unknown())
						.nullable()
						.optional(),
				}),
			}),
		)
		.min(1)
		.max(100),
});

/** Offline bridge for scripts/run-ab-live-e2e.ts reports; never reads citations. */
export function adaptLiveReportForRagas(
	reportInput: unknown,
	retrievalInputs: readonly unknown[],
	generationInputs: readonly unknown[] = [],
): RagasSample[] {
	return adaptCapturedLiveReportForRagas(
		reportInput,
		retrievalInputs,
		false,
		generationInputs,
	);
}

export function serializeRagasJsonl(inputs: readonly unknown[]): string {
	if (inputs.length < 1 || inputs.length > 100)
		throw new Error("expected 1..100 samples");
	const seen = new Set<string>();
	return `${inputs
		.map((input) => {
			const parsed = RagasSampleSchema.safeParse(input);
			if (!parsed.success) throw new Error("invalid Ragas sample");
			const row = parsed.data;
			if (
				(row.context_scope === "full_retrieval") !== (row.retrieval !== null) ||
				(row.context_scope === "unavailable" &&
					row.retrieved_contexts.length !== 0) ||
				(row.provenance.generation_context === "unavailable" &&
					row.generation_contexts.length !== 0) ||
				(row.provenance.response === "server_stream_sha256" &&
					row.response_sha256 !== evaluationTextDigest(row.response)) ||
				(row.provenance.generation_context === "server_model_input" &&
					row.provenance.response !== "server_stream_sha256")
			)
				throw new Error("context scope and retrieval provenance do not match");
			const key = `${row.run_id}/${row.case_id}`;
			if (seen.has(key)) throw new Error("duplicate Ragas sample");
			seen.add(key);
			return JSON.stringify(row);
		})
		.join("\n")}\n`;
}

/** Join request-bound local captures to the answers and fingerprints in a live report. */
export function adaptCapturedLiveReportForRagas(
	reportInput: unknown,
	captureInputs: readonly unknown[],
	allowMissingCaptures = false,
	generationInputs: readonly unknown[] = [],
): RagasSample[] {
	const parsedReport = liveReportSchema.safeParse(reportInput);
	if (!parsedReport.success)
		throw new Error("invalid or unsuccessful live report");
	const report = parsedReport.data;
	function captureMap<
		T extends {
			case_id: string;
			run_id: string;
			request_id: string;
			question_sha256: string;
		},
	>(inputs: readonly unknown[], schema: z.ZodType<T>): Map<string, T> {
		const result = new Map<string, T>();
		for (const input of inputs) {
			const parsed = schema.safeParse(input);
			if (!parsed.success) throw new Error("invalid private capture");
			const capture = parsed.data;
			const row = report.positive_cases.find(
				(item) => item.gold.id === capture.case_id,
			);
			if (
				!row ||
				capture.run_id !== report.run_id ||
				capture.request_id !== row.response.requestId ||
				capture.question_sha256 !== evaluationTextDigest(row.gold.question)
			)
				throw new Error("private capture does not match live run");
			if (result.has(capture.case_id))
				throw new Error("duplicate private capture");
			result.set(capture.case_id, capture);
		}
		return result;
	}
	const retrievals = captureMap(captureInputs, CapturedAskRetrievalSchema);
	const generations = captureMap(generationInputs, CapturedAskGenerationSchema);
	const seen = new Set<string>();
	return report.positive_cases.map(({ gold, response }) => {
		if (seen.has(gold.id)) throw new Error("duplicate live case");
		seen.add(gold.id);
		if (response.retrievalDebug?.judge_mode === "model_error")
			throw new Error("live Judge failed");
		const retrieval = retrievals.get(gold.id);
		const generation = generations.get(gold.id);
		if (!retrieval && !allowMissingCaptures)
			throw new Error(
				"full retrieval snapshot required; citations are insufficient",
			);
		if (
			generation &&
			generation.response_sha256 !== evaluationTextDigest(response.answer)
		)
			throw new Error(
				"server generation response hash does not match live answer",
			);
		return RagasSampleSchema.parse({
			schema_version: 1,
			case_id: gold.id,
			run_id: report.run_id,
			request_id: response.requestId,
			build_fingerprint: report.build_fingerprint,
			question: gold.question,
			response: response.answer,
			context_scope: retrieval ? "full_retrieval" : "unavailable",
			retrieved_contexts: retrieval?.retrieved_contexts ?? [],
			generation_contexts: generation?.generation_contexts ?? [],
			response_sha256: generation?.response_sha256 ?? null,
			provenance: {
				response: generation ? "server_stream_sha256" : "unverified",
				build_fingerprint: "unverified",
				generation_context: generation ? "server_model_input" : "unavailable",
			},
			reference: gold.answer,
			retrieval: retrieval?.retrieval ?? null,
		});
	});
}
