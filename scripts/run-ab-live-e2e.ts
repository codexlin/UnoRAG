#!/usr/bin/env tsx

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROMPT_KEYS, PROMPT_REGISTRY } from "../src/core/ai/prompt-registry";
import { exportCapturedLiveReport } from "./evaluation/export-live";
import {
	buildProviderScorecard,
	evaluateProviderGates,
	evaluateQualityDimensionGates,
	evaluateReleaseGates,
	loadGoldenJsonl,
	loadNegativeGoldenJsonl,
	publishEvaluationScores,
	scoreNegativeCase,
	scorePositiveCase,
	summarizeQualityDimensions,
	summarizeEvaluation,
	type EvaluationCitation,
	type EvaluationResponse,
	type GoldenCase,
	type NegativeCaseScore,
	type NegativeGoldenCase,
	type PositiveCaseScore,
	type ProviderJob,
} from "../src/evaluation";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AB_DIR = resolve(ROOT, "testdata/ab");
const OUTPUT_DIR = resolve(AB_DIR, "_e2e_out");
const TERMINAL_JOB_STATUSES = new Set([
	"completed",
	"failed",
	"dead",
	"cancelled",
]);

type JsonObject = Record<string, unknown>;

export type RunnerOptions = Readonly<{
	baseUrl: string;
	email: string;
	password: string;
	keepLibrary: boolean;
	publishLangfuseScores: boolean;
	jobTimeoutMs: number;
	askTimeoutMs: number;
	pollIntervalMs: number;
	cleanupTimeoutMs: number;
	release: string;
	reuseLibraryId?: string;
	onLibraryReady?: (libraryId: string) => void;
	ragasExport?: { runId: string; captureDirectory: string };
}>;

type JobResult = Readonly<{
	status: string;
	stage: string | null;
	error: string | null;
	parserReport: unknown;
	stageRuns: unknown;
	documentId: string | null;
	waitObservation?: ReturnType<typeof projectJobWaitObservation>;
	readiness?: Readonly<{
		observedAt: string;
		documentStatus: string | null;
		jobId: string | null;
		jobStatus: string | null;
		generationId: string | null;
		chunkCount: number | null;
	}>;
}>;

export function projectJobWaitObservation(job: JsonObject, observedAt = Date.now()) {
	const instant = (value: unknown) => {
		const parsed = typeof value === "string" ? Date.parse(value) : NaN;
		return Number.isFinite(parsed) ? parsed : null;
	};
	const elapsed = (start: number | null, end: number | null) =>
		start !== null && end !== null && end >= start ? end - start : null;
	const created = instant(job.created_at);
	const started = instant(job.started_at);
	const finished = instant(job.finished_at);
	const queueEnd = started ?? (
		job.status === "queued" && (job.started_at === null || job.started_at === undefined)
			? observedAt : null
	);
	const runningEnd = finished ?? (
		job.status === "running" || job.status === "cancelling" ? observedAt : null
	);
	return {
		observedAt: new Date(observedAt).toISOString(),
		status: stringValue(job.status),
		createdAt: stringValue(job.created_at),
		startedAt: stringValue(job.started_at),
		finishedAt: stringValue(job.finished_at),
		queueMs: elapsed(created, queueEnd),
		runningMs: elapsed(started, runningEnd),
	};
}

export function resolveReusedJobs(
	filenames: readonly string[],
	documents: unknown,
): Map<string, JobResult> {
	if (!Array.isArray(documents))
		throw new Error("reused corpus document response must be an array");
	if (
		documents.some(
			(row) =>
				row === null ||
				typeof row !== "object" ||
				Array.isArray(row) ||
				typeof row.filename !== "string" ||
				!row.filename.trim(),
		)
	)
		throw new Error("reused corpus document entries are malformed");
	const rows = documents.map(asObject);
	const observedAt = new Date().toISOString();
	const id = (value: unknown) => stringValue(value)?.trim() || null;
	return new Map(
		filenames.map((filename) => {
			const matches = rows.filter((row) => row.filename === filename);
			const document = matches.length === 1 ? matches[0] : null;
			const ready =
				document?.status === "ready" &&
				document.job_status === "completed" &&
				typeof document.chunk_count === "number" &&
				Number.isSafeInteger(document.chunk_count) &&
				document.chunk_count > 0 &&
				!!id(document.document_id) &&
				!!id(document.job_id) &&
				!!id(document.generation_id);
			return [
				filename,
				{
					status: ready
						? "completed"
						: matches.length > 1
							? "ambiguous_document"
							: document
								? "not_ready"
								: "missing",
					stage: document ? stringValue(document.job_stage) : null,
					error: ready ? null : "reused corpus document readiness unverified",
					parserReport: document?.parser_report ?? null,
					stageRuns: null,
					documentId: document ? id(document.document_id) : null,
					readiness: {
						observedAt,
						documentStatus: stringValue(document?.status),
						jobId: id(document?.job_id),
						jobStatus: stringValue(document?.job_status),
						generationId: id(document?.generation_id),
						chunkCount:
							typeof document?.chunk_count === "number"
								? document.chunk_count
								: null,
					},
				} satisfies JobResult,
			];
		}),
	);
}

type PositiveRow = Readonly<{
	kind: "positive";
	gold: GoldenCase;
	ingestStatus: string;
	ingestDependencies: Readonly<Record<string, string>>;
	response: EvaluationResponse;
	score: PositiveCaseScore;
}>;

type NegativeRow = Readonly<{
	kind: "negative";
	gold: NegativeGoldenCase;
	response: EvaluationResponse;
	score: NegativeCaseScore & { caseId: string };
}>;

function asObject(value: unknown): JsonObject {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: {};
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value ? value : null;
}

function positiveInteger(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`invalid positive integer: ${value}`);
	}
	return parsed;
}

export function validateServiceUrl(value: string, label: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${label} must be a valid URL`);
	}
	if (url.username || url.password) {
		throw new Error(`${label} must not contain URL credentials`);
	}
	const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new Error(`${label} must use HTTPS unless it targets loopback`);
	}
	url.pathname = url.pathname.replace(/\/$/u, "");
	return url.toString().replace(/\/$/u, "");
}

async function readPassword(): Promise<string> {
	const direct = process.env.UNORAG_ADMIN_PASSWORD?.trim();
	if (direct) return direct;
	const passwordFile = process.env.UNORAG_AB_PASSWORD_FILE?.trim();
	if (!passwordFile) return "";
	const expanded = passwordFile.startsWith("~/")
		? resolve(homedir(), passwordFile.slice(2))
		: resolve(passwordFile);
	const info = await stat(expanded);
	if (!info.isFile()) throw new Error("evaluation password path is not a file");
	if ((info.mode & 0o077) !== 0) {
		throw new Error("evaluation password file must not be group/world accessible");
	}
	return (await readFile(expanded, "utf8")).trim();
}

function currentRelease(): string {
	if (process.env.UNORAG_EVAL_RELEASE?.trim()) {
		return process.env.UNORAG_EVAL_RELEASE.trim();
	}
	try {
		const environment = { ...process.env };
		for (const key of [
			"UNORAG_ADMIN_PASSWORD",
			"LANGFUSE_SECRET_KEY",
			"LANGFUSE_OTLP_AUTHORIZATION",
		]) {
			delete environment[key];
		}
		return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
			cwd: ROOT,
			encoding: "utf8",
			env: environment,
		}).trim();
	} catch {
		return "unknown";
	}
}

export async function resolveRunnerOptions(
	args: readonly string[],
): Promise<RunnerOptions> {
	const normalizedArgs = args.filter((arg) => arg !== "--");
	const known = new Set([
		"--keep-library",
		"--publish-langfuse-scores",
		"--export-ragas",
		"--help",
	]);
	for (const arg of normalizedArgs) {
		if (!known.has(arg)) throw new Error(`unknown argument: ${arg}`);
	}
	if (normalizedArgs.includes("--help")) {
		throw new Error(
			"usage: pnpm eval:live [--keep-library] [--publish-langfuse-scores] [--export-ragas]",
		);
	}
	const email = process.env.UNORAG_ADMIN_EMAIL?.trim() ?? "";
	const password = await readPassword();
	if (!email || !password) {
		throw new Error("UNORAG_ADMIN_EMAIL and password are required");
	}
	const runId = process.env.UNORAG_EVAL_CAPTURE_RUN_ID ?? "";
	if (normalizedArgs.includes("--export-ragas") && !/^[a-zA-Z0-9_.:-]{1,64}$/.test(runId)) {
		throw new Error("--export-ragas requires UNORAG_EVAL_CAPTURE_RUN_ID matching the opted-in server");
	}
	return Object.freeze({
		baseUrl: validateServiceUrl(
			process.env.UNORAG_BASE_URL ?? "http://127.0.0.1:3000",
			"UNORAG_BASE_URL",
		),
		email,
		password,
		keepLibrary:
			normalizedArgs.includes("--keep-library") ||
			/^(1|true|yes)$/iu.test(process.env.UNORAG_AB_KEEP_LIBRARY ?? ""),
		publishLangfuseScores: normalizedArgs.includes(
			"--publish-langfuse-scores",
		),
		jobTimeoutMs:
			positiveInteger(process.env.UNORAG_AB_JOB_TIMEOUT_SEC, 900) * 1_000,
		askTimeoutMs:
			positiveInteger(process.env.UNORAG_AB_ASK_TIMEOUT_SEC, 120) * 1_000,
		pollIntervalMs: positiveInteger(
			process.env.UNORAG_AB_POLL_INTERVAL_MS,
			2_000,
		),
		cleanupTimeoutMs:
			positiveInteger(process.env.UNORAG_AB_CLEANUP_TIMEOUT_SEC, 120) * 1_000,
		release: currentRelease(),
		...(normalizedArgs.includes("--export-ragas") ? {
			ragasExport: { runId, captureDirectory: resolve(process.env.UNORAG_EVAL_CAPTURE_INPUT_DIR ?? resolve(ROOT, ".unorag/evaluation")) },
		} : {}),
		...(process.env.UNORAG_AB_LIBRARY_ID?.trim()
			? { reuseLibraryId: process.env.UNORAG_AB_LIBRARY_ID.trim() }
			: {}),
	});
}

function cookieValues(response: Response): string[] {
	const headers = response.headers as Headers & {
		getSetCookie?: () => string[];
	};
	const values = headers.getSetCookie?.() ?? [];
	if (values.length > 0) return values;
	const fallback = response.headers.get("set-cookie");
	return fallback ? [fallback] : [];
}

type EvaluationHttpResponse = { status: number; body: unknown; requestId: string | null };

class EvaluationClient {
	private readonly cookies = new Map<string, string>();

	constructor(private readonly baseUrl: string) {}

	private rememberCookies(response: Response): void {
		for (const value of cookieValues(response)) {
			const pair = value.split(";", 1)[0];
			if (!pair) continue;
			const separator = pair.indexOf("=");
			if (separator <= 0) continue;
			this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
		}
	}

	private cookieHeader(): string {
		return [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
	}

	async request(
		method: string,
		path: string,
		init: Omit<RequestInit, "method"> = {},
		timeoutMs = 60_000,
	): Promise<EvaluationHttpResponse> {
		const headers = new Headers(init.headers);
		const cookies = this.cookieHeader();
		if (cookies) headers.set("cookie", cookies);
		const response = await fetch(`${this.baseUrl}${path}`, {
			...init,
			method,
			headers,
			signal: AbortSignal.timeout(timeoutMs),
		});
		this.rememberCookies(response);
		const metadata = { status: response.status, requestId: response.headers.get("x-request-id") };
		const text = await response.text();
		if (!text) return { ...metadata, body: {} };
		try {
			return { ...metadata, body: JSON.parse(text) };
		} catch {
			return { ...metadata, body: text };
		}
	}

	json(
		method: string,
		path: string,
		payload?: unknown,
		timeoutMs?: number,
	): Promise<EvaluationHttpResponse> {
		return this.request(
			method,
			path,
			payload === undefined
				? {}
				: {
						headers: { "content-type": "application/json" },
						body: JSON.stringify(payload),
					},
			timeoutMs,
		);
	}

	async upload(
		libraryId: string,
		filePath: string,
	): Promise<EvaluationHttpResponse> {
		const form = new FormData();
		form.set(
			"file",
			new Blob([await readFile(filePath)], {
				type: "application/octet-stream",
			}),
			basename(filePath),
		);
		return this.request(
			"POST",
			`/api/libraries/${encodeURIComponent(libraryId)}/documents`,
			{ body: form },
			300_000,
		);
	}
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function waitForJobs(input: {
	client: EvaluationClient;
	uploads: ReadonlyMap<string, { jobId: string; documentId: string | null }>;
	timeoutMs: number;
	pollIntervalMs: number;
}): Promise<Map<string, JobResult>> {
	const results = new Map<string, JobResult>();
	const lastObserved = new Map<string, JobResult>();
	const pending = new Map(input.uploads);
	const deadline = Date.now() + input.timeoutMs;
	while (pending.size > 0 && Date.now() < deadline) {
		for (const [filename, upload] of pending) {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) break;
			let response: EvaluationHttpResponse;
			try {
				response = await input.client.json(
					"GET",
					`/api/jobs/${encodeURIComponent(upload.jobId)}`,
					undefined,
					Math.min(60_000, remainingMs),
				);
			} catch (error) {
				if (Date.now() >= deadline) break;
				throw error;
			}
			if (response.status !== 200) continue;
			const job = asObject(response.body);
			const status = stringValue(job.status) ?? "unknown";
			process.stdout.write(
				`  ${filename}: status=${status} stage=${stringValue(job.stage) ?? "-"}\n`,
			);
			const observed: JobResult = {
				status,
				stage: stringValue(job.stage),
				error: stringValue(job.last_error) ?? stringValue(job.error_code),
				parserReport: job.parser_report ?? null,
				stageRuns: job.stage_runs ?? null,
				documentId: upload.documentId,
				waitObservation: projectJobWaitObservation(job),
			};
			lastObserved.set(filename, observed);
			if (!TERMINAL_JOB_STATUSES.has(status)) continue;
			results.set(filename, observed);
			pending.delete(filename);
		}
		if (pending.size > 0)
			await sleep(Math.min(input.pollIntervalMs, Math.max(0, deadline - Date.now())));
	}
	for (const [filename, upload] of pending) {
		results.set(filename, {
			status: "timeout",
			stage: lastObserved.get(filename)?.stage ?? null,
			error: "job wait timeout",
			parserReport: lastObserved.get(filename)?.parserReport ?? null,
			stageRuns: lastObserved.get(filename)?.stageRuns ?? null,
			documentId: upload.documentId,
			waitObservation: lastObserved.get(filename)?.waitObservation,
		});
	}
	return results;
}

function citationsFrom(value: unknown): EvaluationCitation[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => {
		const citation = asObject(item);
		return {
			index: typeof citation.index === "number" ? citation.index : undefined,
			filename: stringValue(citation.filename),
			file: stringValue(citation.file),
			record_type: stringValue(citation.record_type),
			doc_id: stringValue(citation.doc_id),
			document_version_id: stringValue(citation.document_version_id),
			record_id: stringValue(citation.record_id),
			figure_id: stringValue(citation.figure_id),
			source_chunk_ids: Array.isArray(citation.source_chunk_ids)
				? citation.source_chunk_ids.filter((id): id is string => typeof id === "string")
				: undefined,
			source_node_ids: Array.isArray(citation.source_node_ids)
				? citation.source_node_ids.filter((id): id is string => typeof id === "string")
				: undefined,
			text:
				stringValue(citation.body) ??
				stringValue(citation.text) ??
				stringValue(citation.snippet),
		};
	});
}

async function ask(input: {
	client: EvaluationClient;
	libraryId: string;
	question: string;
	sessionId: string;
	timeoutMs: number;
}): Promise<EvaluationResponse> {
	const startedAt = performance.now();
	const response = await input.client.json(
		"POST",
		"/api/rag/v1/ask",
		{
			question: input.question,
			library_id: input.libraryId,
			session_id: input.sessionId,
		},
		input.timeoutMs,
	);
	const body = asObject(response.body);
	return Object.freeze({
		httpStatus: response.status,
		answer: stringValue(body.answer) ?? "",
		refused: body.refused === true,
		refuseReason: stringValue(body.refuse_reason),
		citations: citationsFrom(body.citations),
		latencyMs: Math.round((performance.now() - startedAt) * 10) / 10,
		requestId: stringValue(body.trace_id) ?? response.requestId,
		traceId: null,
		sessionId: stringValue(body.session_id) ?? input.sessionId,
		retrievalDebug:
			body.retrieval_debug &&
			typeof body.retrieval_debug === "object" &&
			!Array.isArray(body.retrieval_debug)
				? (body.retrieval_debug as Readonly<Record<string, unknown>>)
				: null,
	});
}

function failedIngestResponse(status: string): EvaluationResponse {
	return Object.freeze({
		httpStatus: 503,
		answer: "",
		refused: false,
		refuseReason: `ingest_${status}`,
		citations: [],
		latencyMs: 0,
		requestId: null,
		traceId: null,
		sessionId: null,
	});
}

function compactTimestamp(date = new Date()): string {
	return date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function repositoryCommit(): string | null {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: ROOT,
			encoding: "utf8",
		}).trim();
	} catch {
		return null;
	}
}

function repositoryDirty(): boolean | null {
	try {
		return (
			execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
				cwd: ROOT,
				encoding: "utf8",
			}).trim().length > 0
		);
	} catch {
		return null;
	}
}

function localImageDigest(baseUrl: string, buildRef: string | null): string | null {
	const explicit = process.env.UNORAG_EVAL_IMAGE_DIGEST?.trim();
	if (explicit) return explicit;
	if (!buildRef) return null;
	const hostname = new URL(baseUrl).hostname;
	if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) return null;
	try {
		return execFileSync(
			"docker",
			["image", "inspect", "--format={{.Id}}", buildRef],
			{ encoding: "utf8" },
		).trim();
	} catch {
		return null;
	}
}

function buildFingerprint(baseUrl: string, healthBody: unknown): JsonObject {
	const health = asObject(healthBody);
	const buildRef = stringValue(health.build_ref);
	return {
		git_commit: repositoryCommit(),
		git_dirty: repositoryDirty(),
		runtime_build_ref: buildRef,
		image_digest:
			stringValue(health.image_digest) ?? localImageDigest(baseUrl, buildRef),
		models: {
			chat: stringValue(health.chat_model),
			judge: stringValue(health.judge_model),
			embedding: stringValue(health.embedding_model),
			rerank: stringValue(health.rerank_model),
		},
		prompts: Object.fromEntries(
			PROMPT_KEYS.map((key) => {
				const prompt = PROMPT_REGISTRY[key];
				return [key, { version: prompt.version, digest: prompt.digest }];
			}),
		),
	};
}

function formatPercent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function markdownReport(report: JsonObject): string {
	const summary = asObject(report.summary);
	const gates = asObject(report.release_gates);
	const qualityScorecard = Array.isArray(report.quality_scorecard)
		? (report.quality_scorecard as JsonObject[])
		: [];
	const providerScorecard = asObject(report.provider_scorecard);
	const providers = Array.isArray(providerScorecard.providers)
		? (providerScorecard.providers as JsonObject[])
		: [];
	const rows = Array.isArray(report.positive_cases)
		? (report.positive_cases as JsonObject[])
		: [];
	const lines = [
		`# UnoRAG Live Evaluation ${report.run_id}`,
		"",
		`- release: \`${report.release}\``,
		`- library: \`${report.library_id}\``,
		`- gate: **${gates.ok === true ? "PASS" : "FAIL"}**`,
		`- positive: **${summary.positivePassed}/${summary.positiveCases}**`,
		`- fact coverage: **${Number(summary.meanFactCoverage ?? 0).toFixed(3)}**`,
		`- document Recall@K / MRR: **${Number(summary.documentRecallAtK ?? 0).toFixed(3)} / ${Number(summary.documentMrr ?? 0).toFixed(3)}**`,
		`- citation precision: **${formatPercent(Number(summary.citationPrecision ?? 0))}**`,
		`- cross-document citation rate: **${formatPercent(Number(summary.crossDocumentCitationRate ?? 0))}**`,
		`- legitimate supporting citation rate: **${formatPercent(Number(summary.supportingCitationRate ?? 0))}**`,
		`- invalid cross-document citation rate: **${formatPercent(Number(summary.invalidCrossDocumentCitationRate ?? 0))}**`,
		`- invalid citation rate: **${formatPercent(Number(summary.invalidCitationRate ?? 0))}**`,
		`- evidence candidates / selected (mean): **${summary.meanRetrievedEvidenceCount == null ? "n/a" : Number(summary.meanRetrievedEvidenceCount).toFixed(2)} / ${summary.meanSelectedEvidenceCount == null ? "n/a" : Number(summary.meanSelectedEvidenceCount).toFixed(2)}**`,
		`- evidence selection rate: **${summary.evidenceSelectionRate == null ? "n/a" : formatPercent(Number(summary.evidenceSelectionRate))}**`,
		`- refusal accuracy: **${summary.negativePassed}/${summary.negativeCases}**`,
		`- latency P50 / P95: **${summary.latencyP50Ms ?? "-"} / ${summary.latencyP95Ms ?? "-"} ms**`,
		"",
		"## Quality Dimensions",
		"",
		"| dimension | cases | pass | facts | recall | citation precision | record type |",
		"|---|---:|---:|---:|---:|---:|---:|",
		"",
	];
	for (const score of qualityScorecard) {
		lines.push(
			`| ${score.dimension ?? "-"} | ${score.cases ?? 0} | ${formatPercent(Number(score.passRate ?? 0))} | ${formatPercent(Number(score.meanFactCoverage ?? 0))} | ${formatPercent(Number(score.documentRecallAtK ?? 0))} | ${formatPercent(Number(score.citationPrecision ?? 0))} | ${score.recordTypeAccuracy == null ? "n/a" : formatPercent(Number(score.recordTypeAccuracy))} |`,
		);
	}
	lines.push(
		"",
		"## Parser Providers",
		"",
		`- status: **${providerScorecard.status ?? "unknown"}**`,
		`- missing reports: **${Array.isArray(providerScorecard.missingReports) ? providerScorecard.missingReports.length : 0}**`,
		"",
		"| provider | files | completed | partial | failed pages | latency P50/P95 | cases | pass | citation precision |",
		"|---|---:|---:|---:|---:|---:|---:|---:|---:|",
	);
	for (const provider of providers) {
		lines.push(
			`| ${provider.provider ?? "-"} | ${provider.files ?? 0} | ${provider.completedFiles ?? 0} | ${provider.partialFiles ?? 0} | ${provider.failedPages ?? 0} | ${provider.latencyP50Ms ?? "-"}/${provider.latencyP95Ms ?? "-"} ms | ${provider.positiveCases ?? 0} | ${formatPercent(Number(provider.positivePassRate ?? 0))} | ${formatPercent(Number(provider.citationPrecision ?? 0))} |`,
		);
	}
	lines.push(
		"",
		"## Cases",
		"",
		"| case | file | ingest | pass | fact coverage | doc rank | latency |",
		"|---|---|---|---:|---:|---:|---:|",
	);
	for (const row of rows) {
		const score = asObject(row.score);
		lines.push(
			`| ${asObject(row.gold).id ?? "-"} | ${asObject(row.gold).file ?? "-"} | ${row.ingestStatus ?? "-"} | ${score.ok ? "PASS" : "FAIL"} | ${Number(score.factCoverage ?? 0).toFixed(3)} | ${score.targetDocumentRank ?? "-"} | ${asObject(row.response).latencyMs ?? "-"} |`,
		);
	}
	const failures = Array.isArray(gates.failures) ? gates.failures : [];
	if (failures.length > 0) {
		lines.push("", "## Gate Failures", "");
		for (const failure of failures) lines.push(`- ${failure}`);
	}
	return `${lines.join("\n")}\n`;
}

async function writeReport(report: JsonObject): Promise<{
	jsonPath: string;
	markdownPath: string;
}> {
	await mkdir(OUTPUT_DIR, { recursive: true, mode: 0o700 });
	await chmod(OUTPUT_DIR, 0o700);
	const suffix = String(report.run_id).replace(/^ab-live-/u, "");
	const jsonPath = resolve(OUTPUT_DIR, `ab_live_${suffix}.json`);
	const markdownPath = resolve(OUTPUT_DIR, `ab_live_${suffix}.md`);
	const json = `${JSON.stringify(report, null, 2)}\n`;
	const markdown = markdownReport(report);
	const files: Array<[string, string]> = [
		[jsonPath, json],
		[markdownPath, markdown],
		[resolve(OUTPUT_DIR, "ab_live_latest.json"), json],
		[resolve(OUTPUT_DIR, "ab_live_latest.md"), markdown],
	];
	await Promise.all(
		files.map(async ([path, content]) => {
			await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
			await chmod(path, 0o600);
		}),
	);
	return { jsonPath, markdownPath };
}

async function maybePublishLangfuse(input: {
	enabled: boolean;
	runId: string;
	release: string;
	positive: readonly PositiveCaseScore[];
	negative: readonly (NegativeCaseScore & { caseId: string })[];
}): Promise<JsonObject> {
	if (!input.enabled) return { enabled: false, status: "disabled" };
	const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
	const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
	const rawBaseUrl = process.env.LANGFUSE_BASE_URL?.trim();
	if (!publicKey || !secretKey || !rawBaseUrl) {
		throw new Error(
			"LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL are required for score publishing",
		);
	}
	const baseUrl = validateServiceUrl(rawBaseUrl, "LANGFUSE_BASE_URL");
	const { LangfuseClient } = await import("@langfuse/client");
	const client = new LangfuseClient({ publicKey, secretKey, baseUrl });
	try {
		const publication = await publishEvaluationScores({
			client,
			runId: input.runId,
			release: input.release,
			environment: process.env.LANGFUSE_EVAL_ENVIRONMENT ?? "evaluation",
			positive: input.positive,
			negative: input.negative,
		});
		return { enabled: true, status: "published", ...publication };
	} finally {
		await client.score.shutdown();
	}
}

async function deleteEvaluationLibrary(input: {
	client: EvaluationClient;
	libraryId: string;
	timeoutMs: number;
	pollIntervalMs: number;
}): Promise<void> {
	const path = `/api/libraries/${encodeURIComponent(input.libraryId)}`;
	const deletion = await input.client.json("DELETE", path, undefined, 30_000);
	if (deletion.status === 404) return;
	if (![200, 202, 204].includes(deletion.status)) {
		throw new Error(`evaluation library cleanup failed: HTTP ${deletion.status}`);
	}
	const deadline = Date.now() + input.timeoutMs;
	while (Date.now() < deadline) {
		const current = await input.client.json(
			"GET",
			"/api/libraries",
			undefined,
			30_000,
		);
		if (current.status >= 500) {
			throw new Error(
				`evaluation library cleanup check failed: HTTP ${current.status}`,
			);
		}
		if (current.status !== 200 || !Array.isArray(current.body)) {
			throw new Error(
				`evaluation library cleanup check returned an invalid response: HTTP ${current.status}`,
			);
		}
		const stillVisible = current.body.some((item) => {
			const library = asObject(item);
			return stringValue(library.id) === input.libraryId;
		});
		if (!stillVisible) return;
		await sleep(input.pollIntervalMs);
	}
	throw new Error(`evaluation library cleanup timed out: ${input.libraryId}`);
}

export async function cleanupEvaluationLibrary(
	options: RunnerOptions,
	libraryId: string,
): Promise<void> {
	const client = new EvaluationClient(options.baseUrl);
	const login = await client.json("POST", "/api/auth/session", {
		email: options.email,
		password: options.password,
	});
	if (login.status !== 200) {
		throw new Error(`cleanup login failed: ${login.status}`);
	}
	await deleteEvaluationLibrary({
		client,
		libraryId,
		timeoutMs: options.cleanupTimeoutMs,
		pollIntervalMs: options.pollIntervalMs,
	});
}

export function goldenFixtureFiles(golds: readonly GoldenCase[]): string[] {
	return [
		...new Set(
			golds.flatMap((gold) => [
				gold.file,
				...(gold.supporting_sources ?? []).map((source) => source.file),
			]),
		),
	].sort();
}

export async function runLiveEvaluation(options: RunnerOptions): Promise<number> {
	if (options.ragasExport && !/^[a-zA-Z0-9_.:-]{1,64}$/.test(options.ragasExport.runId)) {
		throw new Error("Ragas export run ID must be 1..64 safe characters");
	}
	const [golds, negativeGolds] = await Promise.all([
		loadGoldenJsonl(resolve(AB_DIR, "golds.jsonl")),
		loadNegativeGoldenJsonl(resolve(AB_DIR, "negative-golds.jsonl")),
	]);
	const filenames = goldenFixtureFiles(golds);
	for (const filename of filenames) {
		await readFile(resolve(AB_DIR, filename));
	}
	const runId = options.ragasExport?.runId ?? `ab-live-${compactTimestamp()}-${randomUUID().slice(0, 8)}`;
	if ([...golds, ...negativeGolds].some((gold) => `unorag-eval-${runId}-${gold.id}`.length > 256)) {
		throw new Error("evaluation session ID exceeds Ask contract limit");
	}
	const client = new EvaluationClient(options.baseUrl);
	process.stdout.write(`== health ${options.baseUrl}\n`);
	const health = await client.json("GET", "/api/rag/health");
	if (health.status !== 200) throw new Error(`health failed: ${health.status}`);

	process.stdout.write("== login\n");
	const login = await client.json("POST", "/api/auth/session", {
		email: options.email,
		password: options.password,
	});
	if (login.status !== 200) throw new Error(`login failed: ${login.status}`);

	const ownsLibrary = !options.reuseLibraryId;
	let libraryId = options.reuseLibraryId;
	if (libraryId) {
		process.stdout.write(`== reuse evaluation library ${libraryId}\n`);
	} else {
		process.stdout.write("== create evaluation library\n");
		const libraryResponse = await client.json("POST", "/api/libraries", {
			name: `AB Live ${runId}`,
		});
		const library = asObject(libraryResponse.body);
		libraryId = stringValue(library.id) ?? undefined;
		if (![200, 201].includes(libraryResponse.status) || !libraryId) {
			throw new Error(`library creation failed: ${libraryResponse.status}`);
		}
	}
	options.onLibraryReady?.(libraryId);

	let report: JsonObject | null = null;
	let resultCode = 2;
	try {
		const uploads = new Map<
			string,
			{ jobId: string; documentId: string | null }
		>();
		const uploadFailures = new Map<string, JobResult>();
		let jobs: Map<string, JobResult>;
		if (ownsLibrary) {
			for (const filename of filenames) {
				const response = await client.upload(libraryId, resolve(AB_DIR, filename));
				const body = asObject(response.body);
				const jobId = stringValue(body.job_id);
				process.stdout.write(`  upload ${filename} -> ${response.status}\n`);
				if (![200, 202].includes(response.status) || !jobId) {
					uploadFailures.set(filename, {
						status: "upload_failed",
						stage: null,
						error: `HTTP ${response.status}`,
						parserReport: null,
						stageRuns: null,
						documentId: stringValue(body.document_id) ?? stringValue(body.id),
					});
					continue;
				}
				uploads.set(filename, {
					jobId,
					documentId: stringValue(body.document_id) ?? stringValue(body.id),
				});
			}

			process.stdout.write("== wait ingestion jobs\n");
			jobs = await waitForJobs({
				client,
				uploads,
				timeoutMs: options.jobTimeoutMs,
				pollIntervalMs: options.pollIntervalMs,
			});
			for (const [filename, failure] of uploadFailures) jobs.set(filename, failure);
		} else {
			const response = await client.json(
				"GET",
				`/api/libraries/${encodeURIComponent(libraryId)}/documents`,
			);
			if (response.status !== 200)
				throw new Error(`reused corpus lookup failed: ${response.status}`);
			jobs = resolveReusedJobs(filenames, response.body);
		}

		process.stdout.write(`== evaluate ${golds.length} positive cases\n`);
		const positiveRows: PositiveRow[] = [];
		for (const [index, gold] of golds.entries()) {
			const ingestDependencies = Object.fromEntries(
				goldenFixtureFiles([gold]).map((filename) => [
					filename,
					jobs.get(filename)?.status ?? "missing",
				]),
			);
			const ingestStatus = Object.values(ingestDependencies).every(
				(status) => status === "completed",
			)
				? "completed"
				: ingestDependencies[gold.file] !== "completed"
					? ingestDependencies[gold.file]
					: "supporting_not_ready";
			const response =
				ingestStatus === "completed"
					? await ask({
							client,
							libraryId,
							question: gold.question,
							sessionId: `unorag-eval-${runId}-${gold.id}`,
							timeoutMs: options.askTimeoutMs,
						})
					: failedIngestResponse(ingestStatus);
			const score = scorePositiveCase(gold, response);
			positiveRows.push({
				kind: "positive",
				gold,
				ingestStatus,
				ingestDependencies,
				response,
				score,
			});
			process.stdout.write(
				`  [${index + 1}/${golds.length}] ${score.ok ? "PASS" : "FAIL"} ${gold.file} missing=${score.missingFacts.join(",")} answer_checks=${score.failedAnswerChecks.join(",")} missing_evidence=${score.missingEvidenceFacts.join(",")}\n`,
			);
		}

		process.stdout.write(`== evaluate ${negativeGolds.length} refusal cases\n`);
		const negativeRows: NegativeRow[] = [];
		for (const [index, gold] of negativeGolds.entries()) {
			const response = await ask({
				client,
				libraryId,
				question: gold.question,
				sessionId: `unorag-eval-${runId}-${gold.id}`,
				timeoutMs: options.askTimeoutMs,
			});
			const score = Object.freeze({
				...scoreNegativeCase(response, gold),
				caseId: gold.id,
			});
			negativeRows.push({ kind: "negative", gold, response, score });
			process.stdout.write(
				`  [N${index + 1}/${negativeGolds.length}] ${score.ok ? "PASS" : "FAIL"}\n`,
			);
		}

		const positiveScores = positiveRows.map((row) => row.score);
		const negativeScores = negativeRows.map((row) => row.score);
		const summary = summarizeEvaluation(positiveScores, negativeScores);
		const qualityScorecard = summarizeQualityDimensions(positiveRows);
		const qualityGates = evaluateQualityDimensionGates(qualityScorecard);
		const providerJobs = Object.fromEntries(jobs) as Record<string, ProviderJob>;
		const providerScorecard = buildProviderScorecard({
			jobs: providerJobs,
			positive: positiveRows,
			freshIngestion: ownsLibrary,
		});
		const providerGates = evaluateProviderGates({
			scorecard: providerScorecard,
			jobs: providerJobs,
		});
		const metricGates = evaluateReleaseGates(summary);
		const corpusReadinessFailures = [...jobs]
			.filter(([, job]) => job.status !== "completed")
			.map(([filename, job]) => `${filename}: corpus readiness ${job.status}`);
		const corpusReadinessGate = {
			ok: corpusReadinessFailures.length === 0,
			failures: corpusReadinessFailures,
		};
		const releaseGates = Object.freeze({
			ok:
				corpusReadinessGate.ok && metricGates.ok && qualityGates.ok && providerGates.ok,
			failures: Object.freeze([
				...corpusReadinessFailures,
				...metricGates.failures,
				...qualityGates.failures,
				...providerGates.failures,
			]),
		});
		let langfuse: JsonObject;
		try {
			langfuse = await maybePublishLangfuse({
				enabled: options.publishLangfuseScores,
				runId,
				release: options.release,
				positive: positiveScores,
				negative: negativeScores,
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : "unknown error";
			process.stderr.write(`!! Langfuse score publishing failed: ${detail}\n`);
			langfuse = { enabled: true, status: "failed", error: detail };
		}
		report = {
			run_id: runId,
			evaluated_at: new Date().toISOString(),
			release: options.release,
			base_url: options.baseUrl,
			build_fingerprint: buildFingerprint(options.baseUrl, health.body),
			library_id: libraryId,
			jobs: Object.fromEntries(jobs),
			corpus_readiness_gate: corpusReadinessGate,
			summary,
			metric_gates: metricGates,
			quality_scorecard: qualityScorecard,
			quality_gates: qualityGates,
			provider_scorecard: providerScorecard,
			provider_gates: providerGates,
			release_gates: releaseGates,
			prompt_policy: "repository-versioned",
			langfuse,
			positive_cases: positiveRows,
			negative_cases: negativeRows,
		};
		const paths = await writeReport(report);
		if (options.ragasExport) {
			try {
				await exportCapturedLiveReport(report, options.ragasExport.captureDirectory, ROOT);
				process.stdout.write("== private Ragas input exported; no semantic judge called\n");
			} catch {
				throw new Error("Ragas export failed: matching full pre-Judge captures required; deterministic report retained");
			}
		}
		process.stdout.write(`== report ${paths.markdownPath}\n`);
		process.stdout.write(`== release gate ${releaseGates.ok ? "PASS" : "FAIL"}\n`);
		resultCode = options.publishLangfuseScores && langfuse.status === "failed"
			? 2
			: !releaseGates.ok
				? 1
				: 0;
	} finally {
		if (!ownsLibrary) {
			process.stdout.write(`== leave reused evaluation library ${libraryId}\n`);
		} else if (options.keepLibrary) {
			process.stdout.write(`== keep evaluation library ${libraryId}\n`);
		} else {
			await deleteEvaluationLibrary({
				client,
				libraryId,
				timeoutMs: options.cleanupTimeoutMs,
				pollIntervalMs: options.pollIntervalMs,
			});
			process.stdout.write(`== cleanup evaluation library ${libraryId} completed\n`);
		}
		if (!report) process.stderr.write("!! evaluation stopped before report write\n");
	}
	return resultCode;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes("--help")) {
		process.stdout.write(
			"usage: pnpm eval:live [--keep-library] [--publish-langfuse-scores]\n",
		);
		return;
	}
	try {
		const options = await resolveRunnerOptions(args);
		process.exitCode = await runLiveEvaluation(options);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		process.stderr.write(`FAIL: ${detail}\n`);
		process.exitCode = 2;
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	void main();
}
