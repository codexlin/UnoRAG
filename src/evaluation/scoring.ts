import type { GoldenCase } from "./golden-set";
import { factMatchesAnswer } from "./golden-set";

export type EvaluationCitation = Readonly<{
	filename?: string | null;
	file?: string | null;
	record_type?: string | null;
}>;

export type EvaluationResponse = Readonly<{
	httpStatus: number;
	answer: string;
	refused: boolean;
	refuseReason?: string | null;
	citations: readonly EvaluationCitation[];
	latencyMs: number;
	requestId?: string | null;
	traceId?: string | null;
	sessionId?: string | null;
}>;

export type PositiveCaseScore = Readonly<{
	caseId: string;
	ok: boolean;
	factCoverage: number;
	matchedFacts: readonly string[];
	missingFacts: readonly string[];
	targetDocumentRank: number | null;
	reciprocalRank: number;
	targetDocumentRecalled: boolean;
	citationCount: number;
	crossDocumentCitationCount: number;
	recordTypeMatched: boolean | null;
	latencyMs: number;
	requestId: string | null;
	traceId: string | null;
	sessionId: string | null;
}>;

export type NegativeCaseScore = Readonly<{
	ok: boolean;
	refused: boolean;
	latencyMs: number;
	requestId: string | null;
	traceId: string | null;
	sessionId: string | null;
}>;

function basename(value: string): string {
	return value.replaceAll("\\", "/").split("/").at(-1) ?? value;
}

export function citationFilename(citation: EvaluationCitation): string {
	return basename(String(citation.filename ?? citation.file ?? ""));
}

function citationMatchesExpectedRecordType(
	citation: EvaluationCitation,
	expected: NonNullable<GoldenCase["expect_record_type"]>,
): boolean {
	const actual = citation.record_type;
	if (expected === "text") {
		return actual === "text" || actual === "chunk" || actual === "section";
	}
	if (expected === "table") {
		return actual === "table" || actual === "table_summary";
	}
	return actual === "image";
}

export function scorePositiveCase(
	gold: GoldenCase,
	response: EvaluationResponse,
): PositiveCaseScore {
	const matchedFacts = gold.key_facts.filter((fact) =>
		factMatchesAnswer(fact, response.answer),
	);
	const missingFacts = gold.key_facts.filter(
		(fact) => !factMatchesAnswer(fact, response.answer),
	);
	const target = basename(gold.file);
	const ranks = response.citations
		.map((citation, index) => ({
			filename: citationFilename(citation),
			rank: index + 1,
		}))
		.filter((item) => item.filename === target)
		.map((item) => item.rank);
	const targetDocumentRank = ranks.at(0) ?? null;
	const targetCitations = response.citations.filter(
		(citation) => citationFilename(citation) === target,
	);
	const expectedRecordType = gold.expect_record_type;
	const recordTypeMatched = expectedRecordType
		? targetCitations.some((citation) =>
				citationMatchesExpectedRecordType(citation, expectedRecordType),
			)
		: null;

	return Object.freeze({
		caseId: gold.id,
		ok:
			response.httpStatus === 200 &&
			!response.refused &&
			missingFacts.length === 0 &&
			targetDocumentRank != null &&
			(!expectedRecordType || recordTypeMatched === true),
		factCoverage: matchedFacts.length / gold.key_facts.length,
		matchedFacts: Object.freeze(matchedFacts),
		missingFacts: Object.freeze(missingFacts),
		targetDocumentRank,
		reciprocalRank: targetDocumentRank ? 1 / targetDocumentRank : 0,
		targetDocumentRecalled: targetDocumentRank != null,
		citationCount: response.citations.length,
		crossDocumentCitationCount: response.citations.filter(
			(citation) => citationFilename(citation) !== target,
		).length,
		recordTypeMatched,
		latencyMs: response.latencyMs,
		requestId: response.requestId ?? null,
		traceId: response.traceId ?? null,
		sessionId: response.sessionId ?? null,
	});
}

export function scoreNegativeCase(
	response: EvaluationResponse,
): NegativeCaseScore {
	return Object.freeze({
		ok: response.httpStatus === 200 && response.refused,
		refused: response.refused,
		latencyMs: response.latencyMs,
		requestId: response.requestId ?? null,
		traceId: response.traceId ?? null,
		sessionId: response.sessionId ?? null,
	});
}

export type EvaluationSummary = Readonly<{
	positiveCases: number;
	positivePassed: number;
	positivePassRate: number;
	meanFactCoverage: number;
	documentRecallAtK: number;
	documentMrr: number;
	crossDocumentCitationRate: number;
	negativeCases: number;
	negativePassed: number;
	refusalAccuracy: number;
	latencyP50Ms: number | null;
	latencyP95Ms: number | null;
	latencyMaxMs: number | null;
}>;

function mean(values: readonly number[]): number {
	return values.length > 0
		? values.reduce((sum, value) => sum + value, 0) / values.length
		: 0;
}

export function percentile(
	values: readonly number[],
	ratio: number,
): number | null {
	if (values.length === 0) return null;
	if (!(ratio > 0 && ratio <= 1))
		throw new Error("percentile ratio is invalid");
	const ordered = [...values].sort((left, right) => left - right);
	const index = Math.min(
		ordered.length - 1,
		Math.max(0, Math.ceil(ordered.length * ratio) - 1),
	);
	return Math.round((ordered[index] ?? 0) * 10) / 10;
}

export function summarizeEvaluation(
	positive: readonly PositiveCaseScore[],
	negative: readonly NegativeCaseScore[],
): EvaluationSummary {
	const citationCount = positive.reduce(
		(sum, score) => sum + score.citationCount,
		0,
	);
	const crossDocumentCitationCount = positive.reduce(
		(sum, score) => sum + score.crossDocumentCitationCount,
		0,
	);
	const latencies = [
		...positive.map((score) => score.latencyMs),
		...negative.map((score) => score.latencyMs),
	];
	const positivePassed = positive.filter((score) => score.ok).length;
	const negativePassed = negative.filter((score) => score.ok).length;
	return Object.freeze({
		positiveCases: positive.length,
		positivePassed,
		positivePassRate: positive.length ? positivePassed / positive.length : 0,
		meanFactCoverage: mean(positive.map((score) => score.factCoverage)),
		documentRecallAtK: mean(
			positive.map((score) => (score.targetDocumentRecalled ? 1 : 0)),
		),
		documentMrr: mean(positive.map((score) => score.reciprocalRank)),
		crossDocumentCitationRate: citationCount
			? crossDocumentCitationCount / citationCount
			: 0,
		negativeCases: negative.length,
		negativePassed,
		refusalAccuracy: negative.length ? negativePassed / negative.length : 0,
		latencyP50Ms: percentile(latencies, 0.5),
		latencyP95Ms: percentile(latencies, 0.95),
		latencyMaxMs: latencies.length ? Math.max(...latencies) : null,
	});
}

export const DEFAULT_RELEASE_GATES = Object.freeze({
	positivePassRate: 1,
	meanFactCoverage: 1,
	documentRecallAtK: 1,
	refusalAccuracy: 1,
});

export type ReleaseGateResult = Readonly<{
	ok: boolean;
	failures: readonly string[];
}>;

export function evaluateReleaseGates(
	summary: EvaluationSummary,
	gates: Readonly<typeof DEFAULT_RELEASE_GATES> = DEFAULT_RELEASE_GATES,
): ReleaseGateResult {
	const failures: string[] = [];
	for (const key of Object.keys(gates) as Array<keyof typeof gates>) {
		if (summary[key] < gates[key]) {
			failures.push(`${key}=${summary[key]} below ${gates[key]}`);
		}
	}
	return Object.freeze({ ok: failures.length === 0, failures });
}
