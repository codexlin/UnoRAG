import type { GoldenCase, QualityDimension } from "./golden-set";
import {
	type PositiveCaseScore,
	percentile,
	summarizeEvaluation,
} from "./scoring";

export type ScoredGoldenCase = Readonly<{
	gold: GoldenCase;
	score: PositiveCaseScore;
}>;

export type QualityDimensionScore = Readonly<{
	dimension: QualityDimension;
	cases: number;
	passed: number;
	passRate: number;
	meanFactCoverage: number;
	documentRecallAtK: number;
	citationPrecision: number;
	crossDocumentCitationRate: number;
	recordTypeAccuracy: number | null;
}>;

export type QualityDimensionGateResult = Readonly<{
	ok: boolean;
	failures: readonly string[];
}>;

export const REQUIRED_QUALITY_DIMENSIONS = Object.freeze([
	"cross_page_table",
	"low_contrast_scan",
] as const satisfies readonly QualityDimension[]);

export function summarizeQualityDimensions(
	rows: readonly ScoredGoldenCase[],
): readonly QualityDimensionScore[] {
	const dimensions = new Set<QualityDimension>();
	for (const row of rows) {
		for (const dimension of row.gold.quality_dimensions) {
			dimensions.add(dimension);
		}
	}
	return Object.freeze(
		[...dimensions].sort().map((dimension) => {
			const scores = rows
				.filter((row) => row.gold.quality_dimensions.includes(dimension))
				.map((row) => row.score);
			const summary = summarizeEvaluation(scores, []);
			const observedRecordTypes = scores.filter(
				(score) => score.recordTypeMatched !== null,
			);
			return Object.freeze({
				dimension,
				cases: scores.length,
				passed: scores.filter((score) => score.ok).length,
				passRate: summary.positivePassRate,
				meanFactCoverage: summary.meanFactCoverage,
				documentRecallAtK: summary.documentRecallAtK,
				citationPrecision: summary.citationPrecision,
				crossDocumentCitationRate: summary.crossDocumentCitationRate,
				recordTypeAccuracy: observedRecordTypes.length
					? observedRecordTypes.filter(
							(score) => score.recordTypeMatched === true,
						).length / observedRecordTypes.length
					: null,
			});
		}),
	);
}

export function evaluateQualityDimensionGates(
	scorecard: readonly QualityDimensionScore[],
	required: readonly QualityDimension[] = REQUIRED_QUALITY_DIMENSIONS,
): QualityDimensionGateResult {
	const failures: string[] = [];
	for (const dimension of required) {
		const score = scorecard.find((item) => item.dimension === dimension);
		if (!score || score.cases === 0) {
			failures.push(`${dimension} has no golden cases`);
			continue;
		}
		for (const [metric, value] of [
			["passRate", score.passRate],
			["meanFactCoverage", score.meanFactCoverage],
			["documentRecallAtK", score.documentRecallAtK],
			["citationPrecision", score.citationPrecision],
		] as const) {
			if (value < 1) failures.push(`${dimension}.${metric}=${value} below 1`);
		}
		if (score.crossDocumentCitationRate > 0) {
			failures.push(
				`${dimension}.crossDocumentCitationRate=${score.crossDocumentCitationRate} above 0`,
			);
		}
		if (score.recordTypeAccuracy !== null && score.recordTypeAccuracy < 1) {
			failures.push(
				`${dimension}.recordTypeAccuracy=${score.recordTypeAccuracy} below 1`,
			);
		}
	}
	return Object.freeze({ ok: failures.length === 0, failures });
}

type ParserReport = Readonly<Record<string, unknown>>;

export type ProviderJob = Readonly<{
	status: string;
	stage?: string | null;
	parserReport?: unknown;
	stageRuns?: unknown;
}>;

export type ProviderScore = Readonly<{
	provider: string;
	files: number;
	completedFiles: number;
	partialFiles: number;
	failedPages: number;
	warningCount: number;
	latencyP50Ms: number | null;
	latencyP95Ms: number | null;
	positiveCases: number;
	positivePassed: number;
	positivePassRate: number;
	meanFactCoverage: number;
	documentRecallAtK: number;
	citationPrecision: number;
}>;

export type ProviderScorecard = Readonly<{
	status: "observed" | "skipped_reused_library";
	files: number;
	missingReports: readonly string[];
	providers: readonly ProviderScore[];
}>;

export type ProviderGateResult = Readonly<{
	ok: boolean;
	skipped: boolean;
	failures: readonly string[];
}>;

function object(value: unknown): ParserReport {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as ParserReport)
		: {};
}

function providerName(report: ParserReport): string {
	const metrics = object(report.metrics);
	for (const value of [metrics.provider, report.backend, report.parser]) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "unknown";
}

function numeric(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;
}

function failedPageCount(report: ParserReport): number {
	return Array.isArray(report.failed_pages) ? report.failed_pages.length : 0;
}

function parserLatency(job: ProviderJob, report: ParserReport): number | null {
	const reported = numeric(report.latency_ms);
	if (reported !== null) return reported;
	if (!Array.isArray(job.stageRuns)) return null;
	const durations = job.stageRuns.flatMap((value) => {
		const run = object(value);
		return run.stage === "parsing" ? (numeric(run.duration_ms) ?? []) : [];
	});
	return durations.length > 0
		? durations.reduce((total, duration) => total + duration, 0)
		: null;
}

export function buildProviderScorecard(input: {
	jobs: Readonly<Record<string, ProviderJob>>;
	positive: readonly ScoredGoldenCase[];
	freshIngestion: boolean;
}): ProviderScorecard {
	if (!input.freshIngestion) {
		return Object.freeze({
			status: "skipped_reused_library",
			files: Object.keys(input.jobs).length,
			missingReports: Object.freeze([]),
			providers: Object.freeze([]),
		});
	}
	const missingReports: string[] = [];
	const grouped = new Map<
		string,
		Array<{ filename: string; job: ProviderJob; report: ParserReport }>
	>();
	for (const [filename, job] of Object.entries(input.jobs)) {
		const report = object(job.parserReport);
		const provider = providerName(report);
		if (provider === "unknown") missingReports.push(filename);
		const rows = grouped.get(provider) ?? [];
		rows.push({ filename, job, report });
		grouped.set(provider, rows);
	}
	const providers = [...grouped.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([provider, files]) => {
			const filenames = new Set(files.map((item) => item.filename));
			const scores = input.positive
				.filter((row) => filenames.has(row.gold.file))
				.map((row) => row.score);
			const summary = summarizeEvaluation(scores, []);
			const latencies = files
				.map((item) => parserLatency(item.job, item.report))
				.filter((value): value is number => value !== null);
			return Object.freeze({
				provider,
				files: files.length,
				completedFiles: files.filter((item) => item.job.status === "completed")
					.length,
				partialFiles: files.filter((item) => item.report.partial === true)
					.length,
				failedPages: files.reduce(
					(sum, item) => sum + failedPageCount(item.report),
					0,
				),
				warningCount: files.reduce(
					(sum, item) =>
						sum +
						(Array.isArray(item.report.warnings)
							? item.report.warnings.length
							: 0),
					0,
				),
				latencyP50Ms: percentile(latencies, 0.5),
				latencyP95Ms: percentile(latencies, 0.95),
				positiveCases: scores.length,
				positivePassed: scores.filter((score) => score.ok).length,
				positivePassRate: summary.positivePassRate,
				meanFactCoverage: summary.meanFactCoverage,
				documentRecallAtK: summary.documentRecallAtK,
				citationPrecision: summary.citationPrecision,
			});
		});
	return Object.freeze({
		status: "observed",
		files: Object.keys(input.jobs).length,
		missingReports: Object.freeze(missingReports.sort()),
		providers: Object.freeze(providers),
	});
}

export function evaluateProviderGates(input: {
	scorecard: ProviderScorecard;
	jobs: Readonly<Record<string, ProviderJob>>;
}): ProviderGateResult {
	if (input.scorecard.status === "skipped_reused_library") {
		return Object.freeze({ ok: true, skipped: true, failures: [] });
	}
	const failures = input.scorecard.missingReports.map(
		(filename) => `${filename} is missing an identifiable parser report`,
	);
	for (const [filename, job] of Object.entries(input.jobs)) {
		if (job.status !== "completed") {
			failures.push(`${filename} ingestion status is ${job.status}`);
		}
		const report = object(job.parserReport);
		if (failedPageCount(report) > 0) {
			failures.push(`${filename} has ${failedPageCount(report)} failed pages`);
		}
	}
	return Object.freeze({
		ok: failures.length === 0,
		skipped: false,
		failures: Object.freeze(failures),
	});
}
