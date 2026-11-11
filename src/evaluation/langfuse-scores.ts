import { createHash } from "node:crypto";
import type { LangfuseClient } from "@langfuse/client";
import type { NegativeCaseScore, PositiveCaseScore } from "./scoring";

type CreateScores = LangfuseClient["api"]["scores"]["create"];
type ScorePayload = Parameters<CreateScores>[0][number];

export interface LangfuseScoreClient {
	api: {
		scores: {
			create(
				...args: Parameters<CreateScores>
			): Promise<Awaited<ReturnType<CreateScores>>>;
		};
	};
}

export type EvaluationScorePublication = Readonly<{
	runId: string;
	release: string;
	environment: string;
	publishedScores: number;
}>;

function scoreId(runId: string, caseId: string, name: string): string {
	const hex = createHash("sha256")
		.update(`${runId}\0${caseId}\0${name}`)
		.digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function externalCaseId(caseId: string): string {
	return createHash("sha256").update(caseId).digest("hex").slice(0, 16);
}

function metadata(input: {
	runId: string;
	release: string;
	caseId: string;
	caseKind: "positive" | "negative";
}): Readonly<Record<string, string>> {
	return Object.freeze({
		unorag_eval_run_id: input.runId,
		unorag_release: input.release,
		unorag_case_id: input.caseId,
		unorag_case_kind: input.caseKind,
	});
}

export async function publishEvaluationScores(input: {
	client: LangfuseScoreClient;
	runId: string;
	release: string;
	environment?: string;
	positive: readonly PositiveCaseScore[];
	negative: readonly (NegativeCaseScore & { caseId: string })[];
}): Promise<EvaluationScorePublication> {
	const environment = input.environment ?? "evaluation";
	if (!/^(?!langfuse)[a-z0-9-_]{1,40}$/u.test(environment)) {
		throw new Error("Langfuse evaluation environment is invalid");
	}
	for (const score of [...input.positive, ...input.negative]) {
		if (!score.sessionId) {
			throw new Error(
				"cannot publish evaluation scores: session ID is missing",
			);
		}
	}
	const payloads: ScorePayload[] = [];
	const publish = (
		sessionId: string,
		caseId: string,
		caseKind: "positive" | "negative",
		name: string,
		value: number,
		dataType: "BOOLEAN" | "NUMERIC",
	) => {
		const publicCaseId = externalCaseId(caseId);
		payloads.push({
			id: scoreId(input.runId, caseId, name),
			sessionId,
			name,
			value,
			dataType,
			environment,
			metadata: metadata({
				runId: input.runId,
				release: input.release,
				caseId: publicCaseId,
				caseKind,
			}),
		});
	};

	for (const score of input.positive) {
		publish(
			score.sessionId as string,
			score.caseId,
			"positive",
			"unorag.eval.pass",
			score.ok ? 1 : 0,
			"BOOLEAN",
		);
		publish(
			score.sessionId as string,
			score.caseId,
			"positive",
			"unorag.eval.fact_coverage",
			score.factCoverage,
			"NUMERIC",
		);
		publish(
			score.sessionId as string,
			score.caseId,
			"positive",
			"unorag.eval.document_recalled",
			score.targetDocumentRecalled ? 1 : 0,
			"BOOLEAN",
		);
		publish(
			score.sessionId as string,
			score.caseId,
			"positive",
			"unorag.eval.citation_precision",
			score.citationPrecision,
			"NUMERIC",
		);
	}
	for (const score of input.negative) {
		publish(
			score.sessionId as string,
			score.caseId,
			"negative",
			"unorag.eval.refusal_correct",
			score.ok ? 1 : 0,
			"BOOLEAN",
		);
	}

	let publishedScores = 0;
	for (let offset = 0; offset < payloads.length; offset += 100) {
		const batch = payloads.slice(offset, offset + 100);
		let response: Awaited<ReturnType<CreateScores>>;
		const controller = new AbortController();
		// The SDK clears its own timeout at headers, before reading the body.
		const deadline = setTimeout(() => controller.abort(), 5_000);
		try {
			response = await input.client.api.scores.create(batch, {
				timeoutInSeconds: 5,
				maxRetries: 0,
				abortSignal: controller.signal,
			});
		} catch {
			// Provider error bodies may echo submitted data or credentials.
			throw new Error("Langfuse score batch request failed");
		} finally {
			clearTimeout(deadline);
		}
		if (!response || typeof response !== "object") {
			throw new Error("Langfuse score batch acknowledgement is invalid");
		}
		if (
			"accepted" in response ||
			"rejected" in response ||
			"errors" in response
		) {
			if (
				!("accepted" in response) ||
				response.accepted !== batch.length ||
				!("rejected" in response) ||
				response.rejected !== 0 ||
				!("errors" in response) ||
				!Array.isArray(response.errors) ||
				response.errors.length !== 0
			) {
				throw new Error("Langfuse score batch was not fully accepted");
			}
		} else if (!("message" in response) || response.message !== "Accepted") {
			throw new Error("Langfuse score batch acknowledgement is invalid");
		}
		publishedScores += batch.length;
	}
	return Object.freeze({
		runId: input.runId,
		release: input.release,
		environment,
		publishedScores,
	});
}
