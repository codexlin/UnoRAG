import {
	AnswerCitationGuard,
	AnswerCitationValidationError,
} from "../core/ai/answer-citations";
import { sharesEvidenceLineage } from "../core/retrieval/evidence-lineage";
import type { GoldenCase, NegativeGoldenCase } from "./golden-set";
import {
	answerCheckMatches,
	answerFactMatches,
	factMatchesAnswer,
} from "./golden-set";

export type EvaluationCitation = Readonly<{
	index?: number;
	filename?: string | null;
	file?: string | null;
	record_type?: string | null;
	text?: string | null;
	doc_id?: string | null;
	document_version_id?: string | null;
	record_id?: string | null;
	figure_id?: string | null;
	source_chunk_ids?: readonly string[];
	source_node_ids?: readonly string[];
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
	retrievalDebug?: Readonly<Record<string, unknown>> | null;
}>;

export type PositiveCaseScore = Readonly<{
	caseId: string;
	ok: boolean;
	factCoverage: number;
	matchedFacts: readonly string[];
	missingFacts: readonly string[];
	failedAnswerChecks: readonly string[];
	targetDocumentRank: number | null;
	reciprocalRank: number;
	targetDocumentRecalled: boolean;
	citationCount: number;
	inlineCitationsValid: boolean;
	crossDocumentCitationCount: number;
	supportingCitationCount: number;
	invalidCrossDocumentCitationCount: number;
	invalidCitationCount: number;
	missingEvidenceFacts: readonly string[];
	citationPrecision: number;
	retrievedEvidenceCount: number | null;
	selectedEvidenceCount: number | null;
	recordTypeMatched: boolean | null;
	conflictExpectationMatched: boolean | null;
	latencyMs: number;
	requestId: string | null;
	traceId: string | null;
	sessionId: string | null;
}>;

export type NegativeCaseScore = Readonly<{
	ok: boolean;
	refused: boolean;
	refusalEvidenceMatched?: boolean;
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
	return actual === "image" || actual === "figure";
}

function debugCount(
	debug: EvaluationResponse["retrievalDebug"],
	key: string,
): number | null {
	const value = debug?.[key];
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: null;
}

export function scorePositiveCase(
	gold: GoldenCase,
	response: EvaluationResponse,
): PositiveCaseScore {
	const conflictCount = debugCount(
		response.retrievalDebug,
		"conflict_evidence_count",
	);
	const conflictExpectationMatched =
		gold.expect_conflict === undefined
			? null
			: conflictCount !== null &&
				(gold.expect_conflict ? conflictCount > 0 : conflictCount === 0);
	const answerAliases = new Map(
		gold.answer_fact_aliases?.map(({ fact, any_of }) => [fact, any_of]),
	);
	const matchedFacts: string[] = [];
	const missingFacts: string[] = [];
	for (const fact of gold.key_facts) {
		const matched = answerFactMatches(
			fact,
			response.answer,
			answerAliases.get(fact),
		);
		(matched ? matchedFacts : missingFacts).push(fact);
	}
	const failedAnswerChecks = (gold.answer_checks ?? [])
		.filter(
			(check) => !answerCheckMatches(check, response.answer, gold.key_facts),
		)
		.map((check) => check.label);
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
	const citationCount = response.citations.length;
	const indexedCitations = response.citations.map((citation, position) => ({
		citation,
		index: citation.index ?? position + 1,
	}));
	const inlineReferences = new Set<number>();
	let inlineCitationsValid = true;
	try {
		const guard = new AnswerCitationGuard(
			indexedCitations.map(({ index }) => index),
			false,
			(index) => inlineReferences.add(index),
		);
		guard.push(response.answer);
		guard.finish();
	} catch (error) {
		if (!(error instanceof AnswerCitationValidationError)) throw error;
		inlineCitationsValid = false;
	}
	const crossDocumentCitationCount = response.citations.filter(
		(citation) => citationFilename(citation) !== target,
	).length;
	const multiSource = !!gold.supporting_sources?.length;
	const verifyCitationFacts =
		gold.require_citation_facts === true || multiSource;
	const referencedTextEvidence =
		gold.require_citation_facts && !multiSource && expectedRecordType === "text"
			? indexedCitations
					.filter(
						({ citation, index }) =>
							inlineReferences.has(index) &&
							citationFilename(citation) === target &&
							citationMatchesExpectedRecordType(citation, "text") &&
							gold.key_facts.some((fact) =>
								factMatchesAnswer(fact, citation.text ?? ""),
							),
					)
					.map(({ citation }) => citation)
			: [];
	const evidenceFacts = new Set<string>();
	let supportingCitationCount = 0;
	let invalidCrossDocumentCitationCount = 0;
	let invalidCitationCount = 0;
	for (const { citation, index } of indexedCitations) {
		const primary = citationFilename(citation) === target;
		// An uncited companion figure is not evidence for a text-only fact.
		if (
			primary &&
			citationMatchesExpectedRecordType(citation, "image") &&
			!inlineReferences.has(index) &&
			referencedTextEvidence.some((text) =>
				sharesEvidenceLineage(text, citation),
			)
		) {
			continue;
		}
		const source = gold.supporting_sources?.find(
			(item) => item.file === citationFilename(citation),
		);
		const facts = primary ? gold.key_facts : (source?.key_facts ?? []);
		const expected = primary ? expectedRecordType : source?.expect_record_type;
		const supported = facts.filter((fact) =>
			factMatchesAnswer(fact, citation.text ?? ""),
		);
		const valid = primary
			? !verifyCitationFacts ||
				(!!expected &&
					citationMatchesExpectedRecordType(citation, expected) &&
					supported.length > 0)
			: !!source &&
				citationMatchesExpectedRecordType(
					citation,
					source.expect_record_type,
				) &&
				supported.length === facts.length;
		if (valid) {
			for (const fact of supported) {
				if (!answerAliases.has(fact) || inlineReferences.has(index)) {
					evidenceFacts.add(fact);
				}
			}
			if (!primary) supportingCitationCount += 1;
		} else {
			invalidCitationCount += 1;
			if (!primary) invalidCrossDocumentCitationCount += 1;
		}
	}
	const missingEvidenceFacts = verifyCitationFacts
		? gold.key_facts.filter((fact) => !evidenceFacts.has(fact))
		: [];
	const retrievedEvidenceCount = debugCount(
		response.retrievalDebug,
		"retrieved_evidence_count",
	);
	const selectedEvidenceCount = debugCount(
		response.retrievalDebug,
		"selected_evidence_count",
	);
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
			failedAnswerChecks.length === 0 &&
			targetDocumentRank != null &&
			invalidCitationCount === 0 &&
			inlineCitationsValid &&
			missingEvidenceFacts.length === 0 &&
			conflictExpectationMatched !== false &&
			(!expectedRecordType || recordTypeMatched === true),
		factCoverage: matchedFacts.length / gold.key_facts.length,
		matchedFacts: Object.freeze(matchedFacts),
		missingFacts: Object.freeze(missingFacts),
		failedAnswerChecks: Object.freeze(failedAnswerChecks),
		targetDocumentRank,
		reciprocalRank: targetDocumentRank ? 1 / targetDocumentRank : 0,
		targetDocumentRecalled: targetDocumentRank != null,
		citationCount,
		inlineCitationsValid,
		crossDocumentCitationCount,
		supportingCitationCount,
		invalidCrossDocumentCitationCount,
		invalidCitationCount,
		missingEvidenceFacts: Object.freeze(missingEvidenceFacts),
		citationPrecision: citationCount
			? (citationCount - invalidCitationCount) / citationCount
			: 0,
		retrievedEvidenceCount,
		selectedEvidenceCount,
		recordTypeMatched,
		conflictExpectationMatched,
		latencyMs: response.latencyMs,
		requestId: response.requestId ?? null,
		traceId: response.traceId ?? null,
		sessionId: response.sessionId ?? null,
	});
}

const TECHNICAL_REFUSALS = new Set([
	"judge_unavailable",
	"invalid_judgement_action",
	"invalid_evidence_selection",
	"invalid_conflict_evidence",
	"comparison_context_exceeds_budget",
	"invalid_graph_state",
	"invalid_rewrite",
]);

export function scoreNegativeCase(
	response: EvaluationResponse,
	gold?: NegativeGoldenCase,
): NegativeCaseScore {
	const requirement = gold?.refusal_evidence;
	const reason = response.refuseReason ?? "";
	const retrieved = response.retrievalDebug?.retrieved_evidence_count;
	const refusalEvidenceMatched =
		requirement &&
		typeof retrieved === "number" &&
		retrieved >= requirement.min_retrieved &&
		requirement.reason_contains.every((alternatives) =>
			alternatives.some((phrase) => factMatchesAnswer(phrase, reason)),
		);
	return Object.freeze({
		ok:
			response.httpStatus === 200 &&
			response.refused &&
			!TECHNICAL_REFUSALS.has(reason) &&
			response.retrievalDebug?.judge_refusal_review !== "invalid_evidence" &&
			(!requirement || refusalEvidenceMatched === true),
		refused: response.refused,
		...(requirement
			? { refusalEvidenceMatched: !!refusalEvidenceMatched }
			: {}),
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
	supportingCitationRate: number;
	invalidCrossDocumentCitationRate: number;
	invalidCitationRate: number;
	citationPrecision: number;
	meanRetrievedEvidenceCount: number | null;
	meanSelectedEvidenceCount: number | null;
	evidenceSelectionRate: number | null;
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

function nullableMean(values: readonly (number | null)[]): number | null {
	const present = values.filter((value): value is number => value !== null);
	return present.length ? mean(present) : null;
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
	const supportingCitationCount = positive.reduce(
		(sum, score) => sum + score.supportingCitationCount,
		0,
	);
	const invalidCrossDocumentCitationCount = positive.reduce(
		(sum, score) => sum + score.invalidCrossDocumentCitationCount,
		0,
	);
	const invalidCitationCount = positive.reduce(
		(sum, score) => sum + score.invalidCitationCount,
		0,
	);
	const retrievedEvidenceCount = positive.reduce(
		(sum, score) => sum + (score.retrievedEvidenceCount ?? 0),
		0,
	);
	const selectedEvidenceCount = positive.reduce(
		(sum, score) => sum + (score.selectedEvidenceCount ?? 0),
		0,
	);
	const evidenceSelectionObserved = positive.some(
		(score) =>
			score.retrievedEvidenceCount !== null &&
			score.selectedEvidenceCount !== null,
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
		supportingCitationRate: citationCount
			? supportingCitationCount / citationCount
			: 0,
		invalidCrossDocumentCitationRate: citationCount
			? invalidCrossDocumentCitationCount / citationCount
			: 0,
		invalidCitationRate: citationCount
			? invalidCitationCount / citationCount
			: 0,
		citationPrecision: citationCount
			? (citationCount - invalidCitationCount) / citationCount
			: 0,
		meanRetrievedEvidenceCount: nullableMean(
			positive.map((score) => score.retrievedEvidenceCount),
		),
		meanSelectedEvidenceCount: nullableMean(
			positive.map((score) => score.selectedEvidenceCount),
		),
		evidenceSelectionRate:
			evidenceSelectionObserved && retrievedEvidenceCount > 0
				? selectedEvidenceCount / retrievedEvidenceCount
				: null,
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
	citationPrecision: 1,
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
