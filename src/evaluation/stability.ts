export type StabilityGateOptions = Readonly<{
	expectedRounds: number;
	maxP95Ms: number;
}>;

type JsonObject = Record<string, unknown>;

export type StabilityCaseResult = Readonly<{
	kind: "positive" | "negative";
	caseId: string;
	passCount: number;
	roundCount: number;
	failedRounds: string[];
	failureStages: Record<string, number>;
	flaky: boolean;
}>;

export type StabilitySummary = Readonly<{
	roundCount: number;
	passedRounds: number;
	maxP95Ms: number;
	modelErrorCount: number;
	fingerprintConsistent: boolean;
	cases: StabilityCaseResult[];
	failureStages: Record<string, number>;
	gate: { ok: boolean; failures: string[] };
}>;

function object(value: unknown): JsonObject {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: {};
}

function string(value: unknown, fallback: string): string {
	return typeof value === "string" && value ? value : fallback;
}

function debugFor(row: JsonObject): JsonObject {
	return object(object(row.response).retrievalDebug);
}

function stageNames(debug: JsonObject): string[] {
	return Array.isArray(debug.stages)
		? debug.stages.map((item) => string(object(item).stage, "")).filter(Boolean)
		: [];
}

export function classifyEvaluationFailure(
	kind: "positive" | "negative",
	row: unknown,
): string {
	const value = object(row);
	const response = object(value.response);
	const score = object(value.score);
	const debug = debugFor(value);
	if (kind === "positive" && value.ingestStatus !== "completed")
		return "ingest";
	if (Number(response.httpStatus ?? 0) !== 200) return "http";
	if (debug.judge_mode === "model_error") return "judge";
	if (kind === "negative")
		return response.refused === true ? "score" : "refusal";
	if (score.targetDocumentRecalled === false) return "retrieval";
	if (Number(score.crossDocumentCitationCount ?? 0) > 0) return "citation";
	if (score.recordTypeMatched === false) return "citation";
	if (Number(score.factCoverage ?? 0) < 1) {
		return stageNames(debug).includes("table_execute")
			? "table_answer"
			: "generation";
	}
	return "score";
}

function fingerprintKey(report: JsonObject): string {
	return JSON.stringify(report.build_fingerprint ?? null);
}

function hasText(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function hasValidFingerprint(report: JsonObject): boolean {
	const fingerprint = object(report.build_fingerprint);
	const models = object(fingerprint.models);
	const prompts = object(fingerprint.prompts);
	return (
		hasText(fingerprint.git_commit) &&
		fingerprint.git_dirty === false &&
		hasText(fingerprint.runtime_build_ref) &&
		hasText(fingerprint.image_digest) &&
		hasText(models.chat) &&
		hasText(models.judge) &&
		hasText(models.embedding) &&
		Object.keys(prompts).length > 0 &&
		Object.values(prompts).every((value) => {
			const prompt = object(value);
			return hasText(prompt.version) && hasText(prompt.digest);
		})
	);
}

export function summarizeStability(
	reports: readonly unknown[],
	options: StabilityGateOptions,
): StabilitySummary {
	const rounds = reports.map(object);
	const cases = new Map<
		string,
		{
			kind: "positive" | "negative";
			caseId: string;
			passCount: number;
			failedRounds: string[];
			failureStages: Record<string, number>;
		}
	>();
	const failureStages: Record<string, number> = {};
	let modelErrorCount = 0;
	for (const report of rounds) {
		const runId = string(report.run_id, "unknown");
		for (const [field, kind] of [
			["positive_cases", "positive"],
			["negative_cases", "negative"],
		] as const) {
			const rows = Array.isArray(report[field]) ? report[field] : [];
			for (const item of rows) {
				const row = object(item);
				const caseId = string(object(row.gold).id, "unknown");
				const key = `${kind}:${caseId}`;
				const current = cases.get(key) ?? {
					kind,
					caseId,
					passCount: 0,
					failedRounds: [],
					failureStages: {},
				};
				const passed = object(row.score).ok === true;
				if (passed) current.passCount += 1;
				else {
					const stage = classifyEvaluationFailure(kind, row);
					current.failedRounds.push(runId);
					current.failureStages[stage] =
						(current.failureStages[stage] ?? 0) + 1;
					failureStages[stage] = (failureStages[stage] ?? 0) + 1;
				}
				if (debugFor(row).judge_mode === "model_error") modelErrorCount += 1;
				cases.set(key, current);
			}
		}
	}

	const roundP95 = rounds.map((report) =>
		Number(object(report.summary).latencyP95Ms ?? 0),
	);
	const maxP95Ms = roundP95.length > 0 ? Math.max(...roundP95) : 0;
	const passedRounds = rounds.filter(
		(report) => object(report.release_gates).ok === true,
	).length;
	const fingerprints = new Set(rounds.map(fingerprintKey));
	const fingerprintConsistent =
		rounds.length > 0 &&
		rounds.every(hasValidFingerprint) &&
		fingerprints.size === 1;
	const caseResults = [...cases.values()]
		.map(
			(item): StabilityCaseResult => ({
				...item,
				roundCount: rounds.length,
				flaky: item.passCount > 0 && item.passCount < rounds.length,
			}),
		)
		.sort((left, right) =>
			`${left.kind}:${left.caseId}`.localeCompare(
				`${right.kind}:${right.caseId}`,
			),
		);
	const failures: string[] = [];
	if (rounds.length !== options.expectedRounds) {
		failures.push(
			`rounds=${rounds.length}, expected=${options.expectedRounds}`,
		);
	}
	if (passedRounds !== rounds.length) {
		failures.push(`passedRounds=${passedRounds}/${rounds.length}`);
	}
	for (const item of caseResults) {
		if (item.passCount !== rounds.length) {
			failures.push(
				`${item.kind}:${item.caseId} passed ${item.passCount}/${rounds.length}`,
			);
		}
	}
	if (modelErrorCount > 0) failures.push(`modelErrors=${modelErrorCount}`);
	if (!fingerprintConsistent)
		failures.push("build fingerprint is missing or changed");
	if (maxP95Ms > options.maxP95Ms) {
		failures.push(`latencyP95=${maxP95Ms}ms exceeds ${options.maxP95Ms}ms`);
	}
	return {
		roundCount: rounds.length,
		passedRounds,
		maxP95Ms,
		modelErrorCount,
		fingerprintConsistent,
		cases: caseResults,
		failureStages,
		gate: { ok: failures.length === 0, failures },
	};
}
