#!/usr/bin/env tsx

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
	question: string;
	excluded_entity: string;
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
	citations: readonly { filename: string | null; record_type: string | null; snippet: string | null }[];
}>;

type NegativeResult = Readonly<{
	id: string;
	excluded_entity: string;
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

type BenchmarkReport = Readonly<{
	run_id: string;
	label: string;
	evaluated_at: string;
	base_url: string;
	library_id: string;
	reused_library: boolean;
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

function normalizeAnswerForNumbers(text: string): string {
	return text.replace(/(\d),(?=\d{3})/gu, "$1");
}

function numberMatches(answerNormalized: string, rawNumber: string): boolean {
	const cleaned = rawNumber.replace(/,/gu, "").trim();
	if (!cleaned) return false;
	if (answerNormalized.includes(cleaned)) return true;
	const numericValue = Number.parseFloat(cleaned.replace(/%$/u, ""));
	if (!Number.isFinite(numericValue)) return false;
	if (cleaned.endsWith("%")) {
		const ratio = (numericValue / 100).toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "");
		return ratio.length >= 3 && answerNormalized.includes(ratio);
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
		`- answered: **${s.answered_count}/${s.positive_cases}** (${formatPct(s.answered_rate)})`,
		`- document Recall@K / MRR: **${formatPct(s.doc_recall_at_k)} / ${s.doc_mrr.toFixed(3)}**`,
		`- inline citation rate: **${formatPct(s.inline_citation_rate)}**`,
		`- numeric / term / combined hit rate: **${formatPct(s.mean_number_hit_rate)} / ${formatPct(s.mean_term_hit_rate)} / ${formatPct(s.mean_fact_hit_rate)}**`,
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
		`| mean_fact_hit_rate | ${formatPct(a.summary.mean_fact_hit_rate)} | ${formatPct(b.summary.mean_fact_hit_rate)} | ${deltaPct(a.summary.mean_fact_hit_rate, b.summary.mean_fact_hit_rate)} |`,
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

async function run(): Promise<void> {
	const args = process.argv.slice(2);
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

	const batchDir = resolve(argValue(args, "--dir") ?? DEFAULT_BATCH_DIR);
	const label = argValue(args, "--label") ?? "baseline";
	const reuseLibraryId = argValue(args, "--reuse-library");
	const cleanupLibrary = args.includes("--cleanup-library");
	const limitRaw = argValue(args, "--limit");
	const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

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
	let positives = lines.filter((c): c is PositiveHfCase => c.polarity === "positive");
	let negatives = lines.filter((c): c is NegativeHfCase => c.polarity === "negative");
	if (limit && Number.isFinite(limit) && limit > 0) {
		positives = positives.slice(0, limit);
		negatives = negatives.slice(0, Math.min(negatives.length, 3));
	}

	const filenames = [...new Set(positives.map((c) => c.file))].sort();
	const runId = `hf-${label}-${compactTimestamp()}-${randomUUID().slice(0, 8)}`;

	const client = new EvaluationClient(baseUrl);
	process.stdout.write(`== health ${baseUrl}\n`);
	const health = await client.json("GET", "/api/rag/health");
	if (health.status !== 200) throw new Error(`health failed: ${health.status}`);

	process.stdout.write("== login\n");
	const login = await client.json("POST", "/api/auth/session", { email, password });
	if (login.status !== 200) throw new Error(`login failed: ${login.status}`);

	let libraryId = reuseLibraryId;
	const ownsLibrary = !libraryId;
	if (libraryId) {
		process.stdout.write(`== reuse library ${libraryId}\n`);
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
	}

	let jobs = new Map<string, JobResult>();
	try {
		if (ownsLibrary) {
			const uploads = new Map<string, { jobId: string; documentId: string | null }>();
			for (const filename of filenames) {
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
			process.stdout.write(`== wait ${uploads.size} ingestion jobs\n`);
			jobs = await waitForJobs({
				client,
				uploads,
				timeoutMs: 1_800_000,
				pollIntervalMs: 3_000,
			});
			const incomplete = [...jobs.entries()].filter(([, j]) => j.status !== "completed");
			if (incomplete.length > 0) {
				process.stderr.write(
					`!! warning: incomplete ingestion jobs: ${incomplete.map(([f, j]) => `${f}:${j.status}`).join(", ")}\n`,
				);
			}
		} else {
			const docsRes = await client.json(
				"GET",
				`/api/libraries/${encodeURIComponent(libraryId)}/documents`,
			);
			const docs = Array.isArray(docsRes.body) ? docsRes.body : [];
			process.stdout.write(`== verified ${docs.length} documents in reused library\n`);
		}

		const positiveResults: PositiveResult[] = [];
		process.stdout.write(`== evaluate ${positives.length} positive cases\n`);
		for (const [index, item] of positives.entries()) {
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
			positiveResults.push(row);
			process.stdout.write(
				`  [${index + 1}/${positives.length}] ${answered && docRecall ? "OK  " : "MISS"} ${item.task_type} ans=${answered} recall=${docRecall}@${docRank ?? "-"} fact=${formatPct(factHitRate)} (${res.latencyMs}ms)\n`,
			);
		}

		const negativeResults: NegativeResult[] = [];
		process.stdout.write(`== evaluate ${negatives.length} negative refusal cases\n`);
		for (const [index, item] of negatives.entries()) {
			const res = await ask({
				client,
				libraryId,
				question: item.question,
				sessionId: `unorag-hf-${runId}-${item.id}`.slice(0, 250),
				timeoutMs: 120_000,
			});
			const passed = res.httpStatus === 200 && res.refused;
			negativeResults.push({
				id: item.id,
				excluded_entity: item.excluded_entity,
				task_type: item.task_type,
				doc_type: item.doc_type,
				question: item.question,
				answer: res.answer,
				http_status: res.httpStatus,
				refused: res.refused,
				refuse_reason: res.refuseReason ?? null,
				passed,
				latency_ms: res.latencyMs,
			});
			process.stdout.write(
				`  [N${index + 1}/${negatives.length}] ${passed ? "PASS" : "FAIL"} entity=${item.excluded_entity} refused=${res.refused}\n`,
			);
		}

		const posCount = positiveResults.length || 1;
		const numWithTotal = positiveResults.filter((r) => r.number_total > 0);
		const termWithTotal = positiveResults.filter((r) => r.term_total > 0);
		const latencies = positiveResults.map((r) => r.latency_ms);

		const report: BenchmarkReport = {
			run_id: runId,
			label,
			evaluated_at: new Date().toISOString(),
			base_url: baseUrl,
			library_id: libraryId,
			reused_library: !ownsLibrary,
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
	} finally {
		if (ownsLibrary && cleanupLibrary && libraryId) {
			await deleteEvaluationLibrary({
				client,
				libraryId,
				timeoutMs: 120_000,
				pollIntervalMs: 2_000,
			});
			process.stdout.write(`== cleaned up library ${libraryId}\n`);
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
