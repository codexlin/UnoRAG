#!/usr/bin/env tsx

import { generateText, Output } from "ai";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { aiConfigFromEnv, createAiProviderRegistry } from "../../src/core/ai";
import { scoreNegativeCase } from "../../src/evaluation/scoring";
import {
	ask,
	buildFingerprint,
	compactTimestamp,
	deleteEvaluationLibrary,
	EvaluationClient,
	type JobResult,
	waitForJobs,
} from "../run-ab-live-e2e";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_BATCH_DIR = resolve(ROOT, ".unorag/hf-eval/batch_cn_v1");
export const REUSABLE_LIBRARY_ID_FILE = "reusable-library-id.txt";

type PositiveHfCase = Readonly<{
	id: string;
	polarity: "positive";
	file: string;
	question: string;
	gold: readonly string[];
	expected_numbers: readonly string[];
	expected_terms: readonly string[];
	task_type: string;
	doc_type: string;
	company: string;
}>;

type NegativeHfCase = Readonly<{
	id: string;
	polarity: "negative";
	refusal_kind?: "out_of_corpus" | "in_corpus_unanswerable";
	question: string;
	excluded_entity: string | null;
	source_doc: string;
	task_type: string;
	doc_type: string;
}>;

type HfCase = PositiveHfCase | NegativeHfCase;

type PositiveResult = Readonly<{
	id: string;
	file: string;
	task_type: string;
	doc_type: string;
	question: string;
	gold: readonly string[];
	answer: string;
	http_status: number;
	refused: boolean;
	refuse_reason: string | null;
	answered: boolean;
	doc_recall: boolean;
	doc_rank: number | null;
	doc_mrr: number;
	citation_count: number;
	has_inline_citation: boolean;
	number_hits: number;
	number_total: number;
	term_hits: number;
	term_total: number;
	fact_hit_rate: number;
	latency_ms: number;
	semantic_verdict?: "correct" | "partial" | "incorrect";
	semantic_score?: number;
	semantic_reason?: string;
	citations: readonly { filename: string | null; record_type: string | null; snippet: string | null }[];
}>;

type NegativeResult = Readonly<{
	id: string;
	refusal_kind: "out_of_corpus" | "in_corpus_unanswerable";
	excluded_entity: string | null;
	task_type: string;
	doc_type: string;
	question: string;
	answer: string;
	http_status: number;
	refused: boolean;
	refuse_reason: string | null;
	passed: boolean;
	latency_ms: number;
}>;

type GroupSummary = Readonly<{
	cases: number;
	answered_rate: number;
	doc_recall_at_k: number;
	doc_mrr: number;
	inline_citation_rate: number;
	mean_fact_hit_rate: number;
	latency_p50_ms: number;
	latency_p95_ms: number;
}>;

type SubsetMetadata = Readonly<{
	only_ids?: readonly string[];
	only_failed_from?: string;
	limit?: number;
	total_positive_cases: number;
	total_negative_cases: number;
}>;

type BenchmarkReport = Readonly<{
	run_id: string;
	label: string;
	evaluated_at: string;
	base_url: string;
	library_id: string;
	reused_library: boolean;
	subset?: SubsetMetadata;
	build_fingerprint: Record<string, unknown>;
	summary: Readonly<{
		positive_cases: number;
		answered_count: number;
		answered_rate: number;
		doc_recall_at_k: number;
		doc_mrr: number;
		inline_citation_rate: number;
		mean_number_hit_rate: number;
		mean_term_hit_rate: number;
		mean_fact_hit_rate: number;
		semantic_accuracy?: number;
		semantic_answered_accuracy?: number;
		negative_cases: number;
		negative_passed: number;
		refusal_accuracy: number;
		latency_p50_ms: number;
		latency_p95_ms: number;
		latency_max_ms: number;
	}>;
	by_task_type: Readonly<Record<string, GroupSummary>>;
	by_doc_type: Readonly<Record<string, GroupSummary>>;
	parser_summary: Readonly<
		Record<
			string,
			{ files: number; completed: number; partial: number; failed_pages: number; mean_latency_ms: number }
		>
	>;
	positive_results: readonly PositiveResult[];
	negative_results: readonly NegativeResult[];
}>;

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function percentile(values: readonly number[], ratio: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil(sorted.length * ratio) - 1),
	);
	return Math.round((sorted[index] ?? 0) * 10) / 10;
}

export function normalizeAnswerForNumbers(text: string): string {
	return text.replace(/(\d),(?=\d{3})/gu, "$1");
}

function extractAnswerNumbers(answerNormalized: string): Array<{ value: number; isPercent: boolean; digits: number }> {
	const matches = answerNormalized.matchAll(/(?<![A-Za-z0-9])-?\d+(?:\.\d+)?%?/gu);
	const results: Array<{ value: number; isPercent: boolean; digits: number }> = [];
	for (const match of matches) {
		const token = match[0];
		const isPercent = token.endsWith("%");
		const digits = token.replace(/[^0-9]/gu, "").length;
		const parsed = Number.parseFloat(isPercent ? token.slice(0, -1) : token);
		if (!Number.isFinite(parsed)) continue;
		results.push({ value: parsed, isPercent, digits });
	}
	return results;
}

export function numberMatches(answerNormalized: string, rawNumber: string): boolean {
	const cleaned = rawNumber.replace(/,/gu, "").trim();
	if (!cleaned) return false;
	if (answerNormalized.includes(cleaned)) return true;
	const isPercent = cleaned.endsWith("%");
	const numericValue = Number.parseFloat(isPercent ? cleaned.slice(0, -1) : cleaned);
	if (!Number.isFinite(numericValue)) return false;

	// Bidirectional % <-> decimal ratio matching (e.g. "0.0361" <-> "3.61%" and "3.61%" <-> "0.0361").
	if (isPercent) {
		const ratio = (numericValue / 100).toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "");
		if (ratio.length >= 3 && answerNormalized.includes(ratio)) return true;
	} else if (numericValue > 0 && numericValue < 1 && cleaned.includes(".")) {
		const pct = (numericValue * 100).toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "");
		if (answerNormalized.includes(`${pct}%`)) return true;
	}

	// Relative tolerance matching (<= 0.5%) for multi-digit/decimal quantities to handle precision/rounding differences.
	const goldDigits = cleaned.replace(/[^0-9]/gu, "").length;
	if (goldDigits >= 3 || cleaned.includes(".")) {
		const answerNumbers = extractAnswerNumbers(answerNormalized);
		for (const candidate of answerNumbers) {
			if (candidate.digits < 2 && !cleaned.includes(".")) continue;
			const targetValues = isPercent
				? [numericValue, numericValue / 100]
				: numericValue > 0 && numericValue < 1 && cleaned.includes(".")
					? [numericValue, numericValue * 100]
					: [numericValue];
			for (const target of targetValues) {
				if (candidate.isPercent && target === numericValue && !isPercent && numericValue >= 1) continue;
				const denom = Math.max(1e-9, Math.abs(target));
				if (Math.abs(candidate.value - target) / denom <= 0.005) {
					return true;
				}
			}
		}
	}
	return false;
}

function summarizeGroup(rows: readonly PositiveResult[]): GroupSummary {
	const count = rows.length || 1;
	const latencies = rows.map((row) => row.latency_ms);
	return {
		cases: rows.length,
		answered_rate: rows.filter((row) => row.answered).length / count,
		doc_recall_at_k: rows.filter((row) => row.doc_recall).length / count,
		doc_mrr: rows.reduce((sum, row) => sum + row.doc_mrr, 0) / count,
		inline_citation_rate:
			rows.filter((row) => row.has_inline_citation).length / count,
		mean_fact_hit_rate:
			rows.reduce((sum, row) => sum + row.fact_hit_rate, 0) / count,
		latency_p50_ms: percentile(latencies, 0.5),
		latency_p95_ms: percentile(latencies, 0.95),
	};
}

function summarizeByKey(
	rows: readonly PositiveResult[],
	selector: (row: PositiveResult) => string,
): Record<string, GroupSummary> {
	const grouped = new Map<string, PositiveResult[]>();
	for (const row of rows) {
		const key = selector(row);
		const list = grouped.get(key) ?? [];
		list.push(row);
		grouped.set(key, list);
	}
	return Object.fromEntries(
		[...grouped.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, list]) => [key, summarizeGroup(list)]),
	);
}

function summarizeParsers(jobs: ReadonlyMap<string, JobResult>) {
	const byProvider = new Map<
		string,
		{ files: number; completed: number; partial: number; failed_pages: number; latencies: number[] }
	>();
	for (const job of jobs.values()) {
		const report = asObject(job.parserReport);
		const provider =
			stringValue(report.backend) ??
			stringValue(report.parser) ??
			"unknown";
		const bucket = byProvider.get(provider) ?? {
			files: 0,
			completed: 0,
			partial: 0,
			failed_pages: 0,
			latencies: [],
		};
		bucket.files += 1;
		if (job.status === "completed") bucket.completed += 1;
		if (report.mode === "partial") bucket.partial += 1;
		if (typeof report.failed_pages === "number") {
			bucket.failed_pages += report.failed_pages;
		}
		if (typeof report.latency_ms === "number") {
			bucket.latencies.push(report.latency_ms);
		}
		byProvider.set(provider, bucket);
	}
	return Object.fromEntries(
		[...byProvider.entries()].map(([provider, bucket]) => [
			provider,
			{
				files: bucket.files,
				completed: bucket.completed,
				partial: bucket.partial,
				failed_pages: bucket.failed_pages,
				mean_latency_ms:
					bucket.latencies.length > 0
						? Math.round(
								bucket.latencies.reduce((a, b) => a + b, 0) /
									bucket.latencies.length,
							)
						: 0,
			},
		]),
	);
}

function formatPct(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function renderMarkdown(report: BenchmarkReport): string {
	const s = report.summary;
	const lines = [
		`# HF Benchmark Report: ${report.run_id} (${report.label})`,
		"",
		`- base_url: \`${report.base_url}\``,
		`- library_id: \`${report.library_id}\` (reused=${report.reused_library})`,
		...(report.subset
			? [
					`- subset: **${s.positive_cases}/${report.subset.total_positive_cases} positive, ${s.negative_cases}/${report.subset.total_negative_cases} negative**${
						report.subset.only_failed_from
							? ` (only_failed_from=\`${basename(report.subset.only_failed_from)}\`)`
							: ""
					}${
						report.subset.only_ids?.length
							? ` (only_ids=${report.subset.only_ids.length})`
							: ""
					}${report.subset.limit ? ` (limit=${report.subset.limit})` : ""}`,
				]
			: []),
		`- answered: **${s.answered_count}/${s.positive_cases}** (${formatPct(s.answered_rate)})`,
		`- document Recall@K / MRR: **${formatPct(s.doc_recall_at_k)} / ${s.doc_mrr.toFixed(3)}**`,
		`- inline citation rate: **${formatPct(s.inline_citation_rate)}**`,
		`- numeric / term / combined hit rate: **${formatPct(s.mean_number_hit_rate)} / ${formatPct(s.mean_term_hit_rate)} / ${formatPct(s.mean_fact_hit_rate)}**`,
		...(s.semantic_accuracy !== undefined
			? [
					`- semantic accuracy (overall / answered): **${formatPct(s.semantic_accuracy)} / ${formatPct(s.semantic_answered_accuracy ?? 0)}**`,
				]
			: []),
		`- refusal accuracy: **${s.negative_passed}/${s.negative_cases}** (${formatPct(s.refusal_accuracy)})`,
		`- latency P50 / P95 / Max: **${s.latency_p50_ms} / ${s.latency_p95_ms} / ${s.latency_max_ms} ms**`,
		"",
		"## By Task Type",
		"",
		"| task_type | cases | answered | doc_recall | doc_mrr | inline_cite | fact_hit | P50/P95 ms |",
		"|---|---:|---:|---:|---:|---:|---:|---:|",
		...Object.entries(report.by_task_type).map(
			([key, g]) =>
				`| ${key} | ${g.cases} | ${formatPct(g.answered_rate)} | ${formatPct(g.doc_recall_at_k)} | ${g.doc_mrr.toFixed(3)} | ${formatPct(g.inline_citation_rate)} | ${formatPct(g.mean_fact_hit_rate)} | ${g.latency_p50_ms}/${g.latency_p95_ms} |`,
		),
		"",
		"## By Scene (doc_type)",
		"",
		"| doc_type | cases | answered | doc_recall | doc_mrr | fact_hit | P50/P95 ms |",
		"|---|---:|---:|---:|---:|---:|---:|",
		...Object.entries(report.by_doc_type).map(
			([key, g]) =>
				`| ${key} | ${g.cases} | ${formatPct(g.answered_rate)} | ${formatPct(g.doc_recall_at_k)} | ${g.doc_mrr.toFixed(3)} | ${formatPct(g.mean_fact_hit_rate)} | ${g.latency_p50_ms}/${g.latency_p95_ms} |`,
		),
		"",
		"## Parser Breakdown",
		"",
		"| provider | files | completed | partial | failed_pages | mean_latency_ms |",
		"|---|---:|---:|---:|---:|---:|",
		...Object.entries(report.parser_summary).map(
			([provider, p]) =>
				`| ${provider} | ${p.files} | ${p.completed} | ${p.partial} | ${p.failed_pages} | ${p.mean_latency_ms} |`,
		),
		"",
		"## Misses / Refused Positives",
		"",
		"| id | task_type | file | answered | doc_recall | fact_hit | refuse_reason |",
		"|---|---|---|---:|---:|---:|---|",
		...report.positive_results
			.filter((r) => !r.answered || !r.doc_recall || r.fact_hit_rate < 0.3)
			.map(
				(r) =>
					`| ${r.id} | ${r.task_type} | ${r.file} | ${r.answered} | ${r.doc_recall} | ${formatPct(r.fact_hit_rate)} | ${r.refuse_reason ?? "-"} |`,
			),
	];
	return `${lines.join("\n")}\n`;
}

async function compareReports(pathA: string, pathB: string): Promise<void> {
	const a = JSON.parse(await readFile(pathA, "utf8")) as BenchmarkReport;
	const b = JSON.parse(await readFile(pathB, "utf8")) as BenchmarkReport;
	const deltaPct = (x: number, y: number) => {
		const d = (y - x) * 100;
		return `${d >= 0 ? "+" : ""}${d.toFixed(1)}pp`;
	};
	const lines = [
		`# Benchmark Diff: ${a.label} (${a.run_id}) -> ${b.label} (${b.run_id})`,
		"",
		"| metric | A | B | delta |",
		"|---|---:|---:|---:|",
		`| answered_rate | ${formatPct(a.summary.answered_rate)} | ${formatPct(b.summary.answered_rate)} | ${deltaPct(a.summary.answered_rate, b.summary.answered_rate)} |`,
		`| doc_recall_at_k | ${formatPct(a.summary.doc_recall_at_k)} | ${formatPct(b.summary.doc_recall_at_k)} | ${deltaPct(a.summary.doc_recall_at_k, b.summary.doc_recall_at_k)} |`,
		`| doc_mrr | ${a.summary.doc_mrr.toFixed(3)} | ${b.summary.doc_mrr.toFixed(3)} | ${(b.summary.doc_mrr - a.summary.doc_mrr >= 0 ? "+" : "") + (b.summary.doc_mrr - a.summary.doc_mrr).toFixed(3)} |`,
		`| inline_citation_rate | ${formatPct(a.summary.inline_citation_rate)} | ${formatPct(b.summary.inline_citation_rate)} | ${deltaPct(a.summary.inline_citation_rate, b.summary.inline_citation_rate)} |`,
		`| mean_number_hit_rate | ${formatPct(a.summary.mean_number_hit_rate)} | ${formatPct(b.summary.mean_number_hit_rate)} | ${deltaPct(a.summary.mean_number_hit_rate, b.summary.mean_number_hit_rate)} |`,
		`| mean_fact_hit_rate | ${formatPct(a.summary.mean_fact_hit_rate)} | ${formatPct(b.summary.mean_fact_hit_rate)} | ${deltaPct(a.summary.mean_fact_hit_rate, b.summary.mean_fact_hit_rate)} |`,
		...(a.summary.semantic_accuracy !== undefined &&
		b.summary.semantic_accuracy !== undefined
			? [
					`| semantic_accuracy | ${formatPct(a.summary.semantic_accuracy)} | ${formatPct(b.summary.semantic_accuracy)} | ${deltaPct(a.summary.semantic_accuracy, b.summary.semantic_accuracy)} |`,
				]
			: []),
		`| refusal_accuracy | ${formatPct(a.summary.refusal_accuracy)} | ${formatPct(b.summary.refusal_accuracy)} | ${deltaPct(a.summary.refusal_accuracy, b.summary.refusal_accuracy)} |`,
		`| latency_p95_ms | ${a.summary.latency_p95_ms} | ${b.summary.latency_p95_ms} | ${Math.round(b.summary.latency_p95_ms - a.summary.latency_p95_ms)}ms |`,
	];

	const byIdA = new Map(a.positive_results.map((r) => [r.id, r]));
	const improved: string[] = [];
	const regressed: string[] = [];
	for (const rowB of b.positive_results) {
		const rowA = byIdA.get(rowB.id);
		if (!rowA) continue;
		const okA = rowA.answered && rowA.doc_recall;
		const okB = rowB.answered && rowB.doc_recall;
		if (!okA && okB) improved.push(`${rowB.id} (${rowB.task_type})`);
		else if (okA && !okB) regressed.push(`${rowB.id} (${rowB.task_type})`);
	}
	lines.push("", `- recall/answer improved (${improved.length}): ${improved.join(", ") || "none"}`);
	lines.push(`- recall/answer regressed (${regressed.length}): ${regressed.join(", ") || "none"}`);
	process.stdout.write(`${lines.join("\n")}\n`);
}

function argValue(args: readonly string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	if (index >= 0 && index + 1 < args.length) return args[index + 1];
	return undefined;
}

function argValues(args: readonly string[], flag: string): string[] {
	const values: string[] = [];
	for (let i = 0; i < args.length; i += 1) {
		if (args[i] === flag && i + 1 < args.length) {
			values.push(args[i + 1] ?? "");
		}
	}
	return values;
}

export function parseOnlyIdsArg(rawValues: readonly string[]): string[] {
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const raw of rawValues) {
		for (const piece of raw.split(",")) {
			const trimmed = piece.trim();
			if (!trimmed || seen.has(trimmed)) continue;
			seen.add(trimmed);
			ids.push(trimmed);
		}
	}
	return ids;
}

export function extractFailedIdsFromReport(report: BenchmarkReport): string[] {
	const seen = new Set<string>();
	const ids: string[] = [];
	const push = (id: string) => {
		if (!id || seen.has(id)) return;
		seen.add(id);
		ids.push(id);
	};
	for (const row of report.positive_results ?? []) {
		const semanticFailed =
			row.semantic_verdict !== undefined && row.semantic_verdict !== "correct";
		if (
			row.http_status !== 200 ||
			!row.answered ||
			!row.doc_recall ||
			semanticFailed
		) {
			push(row.id);
		}
	}
	for (const row of report.negative_results ?? []) {
		if (row.http_status !== 200 || !row.passed) {
			push(row.id);
		}
	}
	return ids;
}

export function isLibraryCorpusReady(
	documents: unknown,
	requiredFilenames: readonly string[],
): boolean {
	if (!Array.isArray(documents) || requiredFilenames.length === 0) return false;
	const readyFilenames = new Set<string>();
	for (const entry of documents) {
		const doc = asObject(entry);
		const filename = stringValue(doc.filename);
		const status = stringValue(doc.status);
		const jobStatus = stringValue(doc.job_status);
		if (
			filename &&
			status === "ready" &&
			(jobStatus === null || jobStatus === "completed")
		) {
			readyFilenames.add(filename);
		}
	}
	return requiredFilenames.every((filename) => readyFilenames.has(filename));
}

export function resolveReuseOrCreateFlag(
	args: readonly string[],
	batchDir: string,
): { enabled: boolean; name: string } {
	const index = args.indexOf("--reuse-or-create");
	if (index < 0) return { enabled: false, name: "" };
	const next = args[index + 1];
	const name =
		next && !next.startsWith("--") && next.trim()
			? next.trim()
			: `HF Eval Corpus ${basename(batchDir)}`;
	return { enabled: true, name };
}

async function readSavedReusableLibraryId(
	batchDir: string,
): Promise<string | null> {
	try {
		const raw = await readFile(
			resolve(batchDir, REUSABLE_LIBRARY_ID_FILE),
			"utf8",
		);
		const trimmed = raw.trim();
		return trimmed || null;
	} catch {
		return null;
	}
}

async function writeSavedReusableLibraryId(
	batchDir: string,
	libraryId: string,
): Promise<string> {
	const targetPath = resolve(batchDir, REUSABLE_LIBRARY_ID_FILE);
	await writeFile(targetPath, `${libraryId}\n`, "utf8");
	return targetPath;
}

const SemanticGradeSchema = z
	.object({
		reason: z.string().trim().min(1),
		verdict: z.enum(["correct", "partial", "incorrect"]),
	})
	.strict();

async function gradeAnswerSemantically(
	model: ReturnType<typeof createAiProviderRegistry>["model"],
	row: Pick<PositiveResult, "question" | "gold" | "answer" | "answered">,
): Promise<{
	semantic_verdict: "correct" | "partial" | "incorrect";
	semantic_score: number;
	semantic_reason: string;
}> {
	if (!row.answered) {
		return {
			semantic_verdict: "incorrect",
			semantic_score: 0,
			semantic_reason: "Question was not answered.",
		};
	}
	const result = await generateText({
		model,
		maxRetries: 1,
		temperature: 0,
		instructions:
			"你是严格的语义评测裁判。对比标准答案（Gold）和系统回答（Answer），仅判断事实、数值（允许四舍五入微小尾差或百分比/小数同义表达）与核心结论是否等价覆盖。" +
			"先在 reason 中简短说明比对依据，再输出 verdict：correct（核心结论与关键数值全部一致，允许措辞不同）、partial（答对部分要点或数值略有缺失/偏差）或 incorrect（核心结论错误或关键数值算错）。",
		messages: [
			{
				role: "user",
				content: `问题：${row.question}\n\n标准答案（Gold）：\n${row.gold.join("\n").slice(0, 1500)}\n\n系统回答（Answer）：\n${row.answer.slice(0, 1500)}`,
			},
		],
		output: Output.object({
			schema: SemanticGradeSchema,
			name: "semantic_grade",
		}),
		abortSignal: AbortSignal.timeout(30_000),
	});
	const parsed = SemanticGradeSchema.parse(result.output);
	const score =
		parsed.verdict === "correct" ? 1 : parsed.verdict === "partial" ? 0.5 : 0;
	return {
		semantic_verdict: parsed.verdict,
		semantic_score: score,
		semantic_reason: parsed.reason,
	};
}

function semanticSummaryFields(
	positives: PositiveResult[],
	enabled: boolean,
): { semantic_accuracy?: number; semantic_answered_accuracy?: number } {
	if (!enabled) return {};
	const posCount = positives.length || 1;
	const answeredRows = positives.filter((r) => r.answered);
	return {
		semantic_accuracy: positives.reduce((s, r) => s + (r.semantic_score ?? 0), 0) / posCount,
		semantic_answered_accuracy:
			answeredRows.length > 0
				? answeredRows.reduce((s, r) => s + (r.semantic_score ?? 0), 0) / answeredRows.length
				: 0,
	};
}

async function rescoreReport(
	reportPath: string,
	casesDir: string,
	semanticJudge: boolean,
): Promise<void> {
	const rawReport = JSON.parse(await readFile(reportPath, "utf8")) as BenchmarkReport;
	const caseLines = (await readFile(resolve(casesDir, "cases.jsonl"), "utf8"))
		.split(/\r?\n/u)
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as HfCase);
	const caseById = new Map(
		caseLines
			.filter((c): c is PositiveHfCase => c.polarity === "positive")
			.map((c) => [c.id, c]),
	);
	const model = semanticJudge ? createAiProviderRegistry(aiConfigFromEnv()).model : null;

	const rescoredPositives: PositiveResult[] = [];
	for (const [index, row] of rawReport.positive_results.entries()) {
		const item = caseById.get(row.id);
		const normalizedAnswer = normalizeAnswerForNumbers(row.answer);
		const lowerAnswer = row.answer.toLowerCase();
		const numberHits = item
			? item.expected_numbers.filter((num) => numberMatches(normalizedAnswer, num)).length
			: row.number_hits;
		const numberTotal = item ? item.expected_numbers.length : row.number_total;
		const termHits = item
			? item.expected_terms.filter((term) => lowerAnswer.includes(term.toLowerCase())).length
			: row.term_hits;
		const termTotal = item ? item.expected_terms.length : row.term_total;
		const totalSignals = numberTotal + termTotal;
		const factHitRate =
			totalSignals > 0
				? (numberHits + termHits) / totalSignals
				: row.answered
					? 1
					: 0;
		let semanticFields: Partial<PositiveResult> = {};
		if (model) {
			semanticFields = await gradeAnswerSemantically(model, row);
			if ((index + 1) % 20 === 0 || index + 1 === rawReport.positive_results.length) {
				process.stdout.write(`  semantic graded ${index + 1}/${rawReport.positive_results.length}\n`);
			}
		}
		rescoredPositives.push({
			...row,
			number_hits: numberHits,
			number_total: numberTotal,
			term_hits: termHits,
			term_total: termTotal,
			fact_hit_rate: factHitRate,
			...semanticFields,
		});
	}

	const posCount = rescoredPositives.length || 1;
	const numWithTotal = rescoredPositives.filter((r) => r.number_total > 0);
	const termWithTotal = rescoredPositives.filter((r) => r.term_total > 0);
	const updated: BenchmarkReport = {
		...rawReport,
		summary: {
			...rawReport.summary,
			mean_number_hit_rate:
				numWithTotal.length > 0
					? numWithTotal.reduce((s, r) => s + r.number_hits / r.number_total, 0) / numWithTotal.length
					: 1,
			mean_term_hit_rate:
				termWithTotal.length > 0
					? termWithTotal.reduce((s, r) => s + r.term_hits / r.term_total, 0) / termWithTotal.length
					: 1,
			mean_fact_hit_rate:
				rescoredPositives.reduce((s, r) => s + r.fact_hit_rate, 0) / posCount,
			...semanticSummaryFields(rescoredPositives, Boolean(model)),
		},
		by_task_type: summarizeByKey(rescoredPositives, (r) => r.task_type),
		by_doc_type: summarizeByKey(rescoredPositives, (r) => r.doc_type),
		positive_results: rescoredPositives,
	};

	const outJson = reportPath.replace(/\.json$/u, ".rescored.json");
	const outMd = reportPath.replace(/\.json$/u, ".rescored.md");
	await writeFile(outJson, JSON.stringify(updated, null, 2), "utf8");
	await writeFile(outMd, renderMarkdown(updated), "utf8");
	process.stdout.write(
		`== rescored: numeric=${formatPct(updated.summary.mean_number_hit_rate)} combined=${formatPct(updated.summary.mean_fact_hit_rate)}${
			updated.summary.semantic_accuracy !== undefined
				? ` semantic_overall=${formatPct(updated.summary.semantic_accuracy)} semantic_answered=${formatPct(updated.summary.semantic_answered_accuracy ?? 0)}`
				: ""
		}\n== saved: ${outMd}\n`,
	);
}

async function run(): Promise<void> {
	const args = process.argv.slice(2);
	const semanticJudge = args.includes("--semantic-judge");
	const rescorePath = argValue(args, "--rescore");
	const batchDir = resolve(argValue(args, "--dir") ?? DEFAULT_BATCH_DIR);
	if (rescorePath) {
		await rescoreReport(resolve(rescorePath), batchDir, semanticJudge);
		return;
	}
	const compareIndex = args.indexOf("--compare");
	if (compareIndex >= 0) {
		const fileA = args[compareIndex + 1];
		const fileB = args[compareIndex + 2];
		if (!fileA || !fileB) {
			throw new Error("usage: --compare <reportA.json> <reportB.json>");
		}
		await compareReports(resolve(fileA), resolve(fileB));
		return;
	}

	const label = argValue(args, "--label") ?? "baseline";
	const reuseLibraryId = argValue(args, "--reuse-library");
	const reuseOrCreate = resolveReuseOrCreateFlag(args, batchDir);
	const cleanupLibrary = args.includes("--cleanup-library");
	const allowIncompleteCorpus = args.includes("--allow-incomplete-corpus");
	if (reuseLibraryId && reuseOrCreate.enabled) {
		throw new Error("cannot combine --reuse-library and --reuse-or-create");
	}
	if (reuseOrCreate.enabled && cleanupLibrary) {
		throw new Error("cannot combine --reuse-or-create and --cleanup-library");
	}
	const onlyIds = parseOnlyIdsArg(argValues(args, "--only-ids"));
	const onlyFailedFromRaw = argValue(args, "--only-failed-from");
	const onlyFailedFromPath = onlyFailedFromRaw
		? resolve(onlyFailedFromRaw)
		: undefined;
	const ingestTimeoutRaw = argValue(args, "--ingest-timeout-ms");
	const parsedIngestTimeout = ingestTimeoutRaw
		? Number.parseInt(ingestTimeoutRaw, 10)
		: 3_600_000;
	const ingestTimeoutMs =
		Number.isInteger(parsedIngestTimeout) && parsedIngestTimeout >= 60_000
			? parsedIngestTimeout
			: 3_600_000;
	const limitRaw = argValue(args, "--limit");
	const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
	const concurrencyRaw = argValue(args, "--concurrency");
	const parsedConcurrency = concurrencyRaw
		? Number.parseInt(concurrencyRaw, 10)
		: 1;
	const concurrency =
		Number.isInteger(parsedConcurrency) && parsedConcurrency >= 1
			? Math.min(parsedConcurrency, 8)
			: 1;

	const baseUrl = (process.env.UNORAG_BASE_URL ?? "http://localhost:3002").replace(/\/$/, "");
	const email = process.env.UNORAG_ADMIN_EMAIL ?? "admin@unorag.local";
	const password = process.env.UNORAG_ADMIN_PASSWORD ?? "";
	if (!password) {
		throw new Error("UNORAG_ADMIN_PASSWORD environment variable is required");
	}

	const lines = (await readFile(resolve(batchDir, "cases.jsonl"), "utf8"))
		.split(/\r?\n/u)
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as HfCase);
	const allPositives = lines.filter(
		(c): c is PositiveHfCase => c.polarity === "positive",
	);
	const allNegatives = lines.filter(
		(c): c is NegativeHfCase => c.polarity === "negative",
	);
	let positives = [...allPositives];
	let negatives = [...allNegatives];

	let subset: SubsetMetadata | undefined;
	let selectedIds: Set<string> | null = null;
	if (onlyFailedFromPath) {
		const priorReport = JSON.parse(
			await readFile(onlyFailedFromPath, "utf8"),
		) as BenchmarkReport;
		const failedIds = extractFailedIdsFromReport(priorReport);
		if (failedIds.length === 0 && onlyIds.length === 0) {
			process.stdout.write(
				`== 0 failed cases in ${onlyFailedFromPath}; nothing to re-run\n`,
			);
			return;
		}
		selectedIds = new Set([...failedIds, ...onlyIds]);
	} else if (onlyIds.length > 0) {
		selectedIds = new Set(onlyIds);
	}

	if (selectedIds) {
		const allCaseIds = new Set([...allPositives, ...allNegatives].map((c) => c.id));
		const unknownIds = [...selectedIds].filter((id) => !allCaseIds.has(id));
		if (unknownIds.length > 0) {
			process.stderr.write(
				`!! warning: unknown case IDs ignored: ${unknownIds.join(", ")}\n`,
			);
		}
		positives = positives.filter((c) => selectedIds.has(c.id));
		negatives = negatives.filter((c) => selectedIds.has(c.id));
		if (positives.length === 0 && negatives.length === 0) {
			throw new Error(
				`no benchmark cases matched filter (${[...selectedIds].join(", ")})`,
			);
		}
		subset = {
			...(onlyIds.length > 0 ? { only_ids: onlyIds } : {}),
			...(onlyFailedFromPath ? { only_failed_from: onlyFailedFromPath } : {}),
			total_positive_cases: allPositives.length,
			total_negative_cases: allNegatives.length,
		};
	}

	if (limit && Number.isFinite(limit) && limit > 0) {
		positives = positives.slice(0, limit);
		negatives = negatives.slice(0, Math.min(negatives.length, 3));
		subset = {
			...(subset ?? {
				total_positive_cases: allPositives.length,
				total_negative_cases: allNegatives.length,
			}),
			limit,
		};
	}

	// When creating a reusable corpus, always upload the full batch corpus unless --limit explicitly reduced it.
	const fullBatchFilenames = [...new Set(allPositives.map((c) => c.file))].sort();
	const subsetFilenames = [...new Set(positives.map((c) => c.file))].sort();
	const requiredFilenames =
		subsetFilenames.length > 0 ? subsetFilenames : fullBatchFilenames;
	const uploadFilenames =
		reuseOrCreate.enabled && !limit ? fullBatchFilenames : requiredFilenames;
	const runId = `hf-${label}-${compactTimestamp()}-${randomUUID().slice(0, 8)}`;

	const client = new EvaluationClient(baseUrl);
	process.stdout.write(`== health ${baseUrl}\n`);
	const health = await client.json("GET", "/api/rag/health");
	if (health.status !== 200) throw new Error(`health failed: ${health.status}`);

	process.stdout.write("== login\n");
	const login = await client.json("POST", "/api/auth/session", { email, password });
	if (login.status !== 200) throw new Error(`login failed: ${login.status}`);

	let libraryId = reuseLibraryId;
	let ownsLibrary = false;
	if (libraryId) {
		process.stdout.write(`== reuse library ${libraryId}\n`);
	} else if (reuseOrCreate.enabled) {
		const savedId = await readSavedReusableLibraryId(batchDir);
		if (savedId) {
			const docsRes = await client.json(
				"GET",
				`/api/libraries/${encodeURIComponent(savedId)}/documents`,
			);
			if (
				docsRes.status === 200 &&
				isLibraryCorpusReady(docsRes.body, requiredFilenames)
			) {
				libraryId = savedId;
				process.stdout.write(
					`== reuse saved corpus library ${libraryId} (${REUSABLE_LIBRARY_ID_FILE})\n`,
				);
			}
		}
		if (!libraryId) {
			const libsRes = await client.json("GET", "/api/libraries");
			const libraries = Array.isArray(libsRes.body) ? libsRes.body : [];
			for (const entry of libraries) {
				const lib = asObject(entry);
				const candidateId = stringValue(lib.id);
				const candidateName = stringValue(lib.name);
				const candidateStatus = stringValue(lib.status);
				if (
					!candidateId ||
					candidateName !== reuseOrCreate.name ||
					candidateStatus === "deleting" ||
					candidateStatus === "deleted"
				) {
					continue;
				}
				const docsRes = await client.json(
					"GET",
					`/api/libraries/${encodeURIComponent(candidateId)}/documents`,
				);
				if (
					docsRes.status === 200 &&
					isLibraryCorpusReady(docsRes.body, requiredFilenames)
				) {
					libraryId = candidateId;
					const savedPath = await writeSavedReusableLibraryId(batchDir, libraryId);
					process.stdout.write(
						`== reuse existing named library "${reuseOrCreate.name}" (${libraryId}, saved -> ${savedPath})\n`,
					);
					break;
				}
			}
		}
		if (!libraryId) {
			process.stdout.write(
				`== create reusable library "${reuseOrCreate.name}"\n`,
			);
			const created = await client.json("POST", "/api/libraries", {
				name: reuseOrCreate.name,
			});
			const body = asObject(created.body);
			libraryId = stringValue(body.id) ?? undefined;
			if (![200, 201].includes(created.status) || !libraryId) {
				throw new Error(`library creation failed: ${created.status}`);
			}
			ownsLibrary = true;
		}
	} else {
		process.stdout.write(`== create library HF Eval ${runId}\n`);
		const created = await client.json("POST", "/api/libraries", {
			name: `HF Eval ${runId}`,
		});
		const body = asObject(created.body);
		libraryId = stringValue(body.id) ?? undefined;
		if (![200, 201].includes(created.status) || !libraryId) {
			throw new Error(`library creation failed: ${created.status}`);
		}
		ownsLibrary = true;
	}

	let jobs = new Map<string, JobResult>();
	let evaluationFailed = false;
	try {
		if (ownsLibrary) {
			const uploads = new Map<string, { jobId: string; documentId: string | null }>();
			for (const filename of uploadFilenames) {
				const filePath = resolve(batchDir, "pdfs", filename);
				const res = await client.upload(libraryId, filePath);
				const body = asObject(res.body);
				const jobId = stringValue(body.job_id);
				process.stdout.write(`  upload ${filename} -> ${res.status}\n`);
				if (![200, 202].includes(res.status) || !jobId) {
					throw new Error(`upload failed for ${filename}: HTTP ${res.status}`);
				}
				uploads.set(filename, {
					jobId,
					documentId: stringValue(body.document_id) ?? stringValue(body.id),
				});
			}
			process.stdout.write(
				`== wait ${uploads.size} ingestion jobs (timeout=${Math.round(ingestTimeoutMs / 1_000)}s)\n`,
			);
			jobs = await waitForJobs({
				client,
				uploads,
				timeoutMs: ingestTimeoutMs,
				pollIntervalMs: 3_000,
			});
			const incomplete = [...jobs.entries()].filter(([, j]) => j.status !== "completed");
			if (incomplete.length > 0) {
				const summary = incomplete
					.map(([f, j]) => `${f}:${j.status}`)
					.join(", ");
				if (!allowIncompleteCorpus) {
					throw new Error(`incomplete ingestion jobs: ${summary}`);
				}
				process.stderr.write(`!! warning: incomplete ingestion jobs: ${summary}\n`);
			} else if (!cleanupLibrary && !limit) {
				const savedPath = await writeSavedReusableLibraryId(batchDir, libraryId);
				process.stdout.write(`== saved reusable library id -> ${savedPath}\n`);
			}
		} else {
			const docsRes = await client.json(
				"GET",
				`/api/libraries/${encodeURIComponent(libraryId)}/documents`,
			);
			const docs = Array.isArray(docsRes.body) ? docsRes.body : [];
			process.stdout.write(`== verified ${docs.length} documents in reused library\n`);
		}

		const semanticModel = semanticJudge
			? createAiProviderRegistry(aiConfigFromEnv()).model
			: null;
		const runPool = async <T, R>(
			items: readonly T[],
			worker: (item: T, index: number) => Promise<R>,
		): Promise<R[]> => {
			const results = new Array<R>(items.length);
			let cursor = 0;
			let stopped = false;
			let firstError: unknown;
			const workerCount = Math.min(concurrency, items.length);
			await Promise.allSettled(
				Array.from({ length: workerCount }, async () => {
					try {
						while (!stopped) {
							const current = cursor;
							cursor += 1;
							if (current >= items.length) return;
							results[current] = await worker(items[current], current);
						}
					} catch (error) {
						if (!stopped) firstError = error;
						stopped = true;
						throw error;
					}
				}),
			);
			if (stopped) throw firstError;
			return results;
		};

		process.stdout.write(
			`== evaluate ${positives.length} positive cases (concurrency=${concurrency})\n`,
		);
		const positiveResults = await runPool(positives, async (item, index) => {
			const res = await ask({
				client,
				libraryId,
				question: item.question,
				sessionId: `unorag-hf-${runId}-${item.id}`.slice(0, 250),
				timeoutMs: 120_000,
			});
			const answered =
				res.httpStatus === 200 && !res.refused && res.answer.trim().length > 0;
			const rankIndex = res.citations.findIndex(
				(c) => basename(c.filename ?? c.file ?? "") === item.file,
			);
			const docRecall = rankIndex >= 0;
			const docRank = docRecall ? rankIndex + 1 : null;
			const docMrr = docRank ? 1 / docRank : 0;
			const normalizedAnswer = normalizeAnswerForNumbers(res.answer);
			const lowerAnswer = res.answer.toLowerCase();
			const numberHits = item.expected_numbers.filter((num) =>
				numberMatches(normalizedAnswer, num),
			).length;
			const termHits = item.expected_terms.filter((term) =>
				lowerAnswer.includes(term.toLowerCase()),
			).length;
			const totalSignals =
				item.expected_numbers.length + item.expected_terms.length;
			const factHitRate =
				totalSignals > 0
					? (numberHits + termHits) / totalSignals
					: answered
						? 1
						: 0;
			const hasInlineCitation = /\[\d+\]/u.test(res.answer);

			const row: PositiveResult = {
				id: item.id,
				file: item.file,
				task_type: item.task_type,
				doc_type: item.doc_type,
				question: item.question,
				gold: item.gold,
				answer: res.answer,
				http_status: res.httpStatus,
				refused: res.refused,
				refuse_reason: res.refuseReason ?? null,
				answered,
				doc_recall: docRecall,
				doc_rank: docRank,
				doc_mrr: docMrr,
				citation_count: res.citations.length,
				has_inline_citation: hasInlineCitation,
				number_hits: numberHits,
				number_total: item.expected_numbers.length,
				term_hits: termHits,
				term_total: item.expected_terms.length,
				fact_hit_rate: factHitRate,
				latency_ms: res.latencyMs,
				citations: res.citations.slice(0, 8).map((c) => ({
					filename: c.filename ?? c.file ?? null,
					record_type: c.record_type ?? null,
					snippet: c.text ? c.text.slice(0, 240) : null,
				})),
			};
			if (semanticModel) {
				Object.assign(row, await gradeAnswerSemantically(semanticModel, row));
			}
			process.stdout.write(
				`  [${index + 1}/${positives.length}] ${answered && docRecall ? "OK  " : "MISS"} ${item.task_type} ans=${answered} recall=${docRecall}@${docRank ?? "-"} fact=${formatPct(factHitRate)} (${res.latencyMs}ms)\n`,
			);
			return row;
		});

		process.stdout.write(
			`== evaluate ${negatives.length} negative refusal cases (concurrency=${concurrency})\n`,
		);
		const negativeResults = await runPool(negatives, async (item, index) => {
			const res = await ask({
				client,
				libraryId,
				question: item.question,
				sessionId: `unorag-hf-${runId}-${item.id}`.slice(0, 250),
				timeoutMs: 120_000,
			});
			const passed = scoreNegativeCase(res).ok;
			const refusalKind =
				item.refusal_kind ?? (item.excluded_entity ? "out_of_corpus" : "in_corpus_unanswerable");
			const row: NegativeResult = {
				id: item.id,
				refusal_kind: refusalKind,
				excluded_entity: item.excluded_entity ?? null,
				task_type: item.task_type,
				doc_type: item.doc_type,
				question: item.question,
				answer: res.answer,
				http_status: res.httpStatus,
				refused: res.refused,
				refuse_reason: res.refuseReason ?? null,
				passed,
				latency_ms: res.latencyMs,
			};
			process.stdout.write(
				`  [N${index + 1}/${negatives.length}] ${passed ? "PASS" : "FAIL"} kind=${refusalKind} target=${item.excluded_entity ?? item.source_doc} refused=${res.refused}\n`,
			);
			return row;
		});

		const posCount = positiveResults.length || 1;
		const numWithTotal = positiveResults.filter((r) => r.number_total > 0);
		const termWithTotal = positiveResults.filter((r) => r.term_total > 0);
		const latencies = (
			positiveResults.length > 0 ? positiveResults : negativeResults
		).map((r) => r.latency_ms);

		const report: BenchmarkReport = {
			run_id: runId,
			label,
			evaluated_at: new Date().toISOString(),
			base_url: baseUrl,
			library_id: libraryId,
			reused_library: !ownsLibrary,
			...(subset ? { subset } : {}),
			build_fingerprint: buildFingerprint(baseUrl, health.body),
			summary: {
				positive_cases: positiveResults.length,
				answered_count: positiveResults.filter((r) => r.answered).length,
				answered_rate: positiveResults.filter((r) => r.answered).length / posCount,
				doc_recall_at_k: positiveResults.filter((r) => r.doc_recall).length / posCount,
				doc_mrr: positiveResults.reduce((s, r) => s + r.doc_mrr, 0) / posCount,
				inline_citation_rate:
					positiveResults.filter((r) => r.has_inline_citation).length / posCount,
				mean_number_hit_rate:
					numWithTotal.length > 0
						? numWithTotal.reduce((s, r) => s + r.number_hits / r.number_total, 0) /
							numWithTotal.length
						: 1,
				mean_term_hit_rate:
					termWithTotal.length > 0
						? termWithTotal.reduce((s, r) => s + r.term_hits / r.term_total, 0) /
							termWithTotal.length
						: 1,
				mean_fact_hit_rate:
					positiveResults.reduce((s, r) => s + r.fact_hit_rate, 0) / posCount,
				...semanticSummaryFields(positiveResults, Boolean(semanticModel)),
				negative_cases: negativeResults.length,
				negative_passed: negativeResults.filter((r) => r.passed).length,
				refusal_accuracy:
					negativeResults.length > 0
						? negativeResults.filter((r) => r.passed).length / negativeResults.length
						: 1,
				latency_p50_ms: percentile(latencies, 0.5),
				latency_p95_ms: percentile(latencies, 0.95),
				latency_max_ms: latencies.length ? Math.max(...latencies) : 0,
			},
			by_task_type: summarizeByKey(positiveResults, (r) => r.task_type),
			by_doc_type: summarizeByKey(positiveResults, (r) => r.doc_type),
			parser_summary: summarizeParsers(jobs),
			positive_results: positiveResults,
			negative_results: negativeResults,
		};

		const reportsDir = resolve(batchDir, "reports");
		await mkdir(reportsDir, { recursive: true });
		const jsonPath = resolve(reportsDir, `${runId}.json`);
		const mdPath = resolve(reportsDir, `${runId}.md`);
		await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
		await writeFile(mdPath, renderMarkdown(report), "utf8");
		process.stdout.write(`== saved report: ${mdPath}\n== library_id: ${libraryId}\n`);
		if (!cleanupLibrary) {
			process.stdout.write(`== reuse without re-ingest via: --reuse-library ${libraryId}\n`);
		}
	} catch (error) {
		evaluationFailed = true;
		throw error;
	} finally {
		if (ownsLibrary && cleanupLibrary && libraryId) {
			try {
				await deleteEvaluationLibrary({
					client,
					libraryId,
					timeoutMs: 120_000,
					pollIntervalMs: 2_000,
				});
				process.stdout.write(`== cleaned up library ${libraryId}\n`);
			} catch (error) {
				if (!evaluationFailed) throw error;
				const detail = error instanceof Error ? error.message : String(error);
				process.stderr.write(`!! cleanup failed: ${detail}\n`);
			}
		}
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	void run().catch((error) => {
		const detail = error instanceof Error ? error.stack ?? error.message : String(error);
		process.stderr.write(`FAIL: ${detail}\n`);
		process.exitCode = 1;
	});
}
