import { createHash } from "node:crypto";
import type { LangfuseClient } from "@langfuse/client";
import type { NegativeCaseScore, PositiveCaseScore } from "./scoring";

type ScorePayload = Parameters<LangfuseClient["score"]["create"]>[0];

export interface LangfuseScoreClient {
	score: {
		create(payload: ScorePayload): void;
		flush(): Promise<void>;
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
			throw new Error(`cannot publish ${score.caseId}: session ID is missing`);
		}
	}
	let publishedScores = 0;
	const publish = (
		sessionId: string,
		caseId: string,
		caseKind: "positive" | "negative",
		name: string,
		value: number,
		dataType: "BOOLEAN" | "NUMERIC",
	) => {
		const publicCaseId = externalCaseId(caseId);
		input.client.score.create({
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
		publishedScores += 1;
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

	await input.client.score.flush();
	return Object.freeze({
		runId: input.runId,
		release: input.release,
		environment,
		publishedScores,
	});
}
