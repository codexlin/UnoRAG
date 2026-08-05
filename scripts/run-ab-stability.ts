#!/usr/bin/env tsx

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeStability } from "../src/evaluation/stability";
import {
	cleanupEvaluationLibrary,
	resolveRunnerOptions,
	runLiveEvaluation,
} from "./run-ab-live-e2e";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = resolve(ROOT, "testdata/ab/_e2e_out");

type JsonObject = Record<string, unknown>;
type Gate = { ok: boolean; failures: string[] };

function positiveInteger(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`invalid positive integer: ${value}`);
	}
	return parsed;
}

export function resolveStabilityOptions(args: readonly string[]): {
	rounds: number;
	maxP95Ms: number;
} {
	let rounds = positiveInteger(process.env.UNORAG_STABILITY_ROUNDS, 3);
	let maxP95Ms = positiveInteger(process.env.UNORAG_STABILITY_MAX_P95_MS, 15_000);
	for (const arg of args.filter((value) => value !== "--")) {
		if (arg === "--help") continue;
		if (arg.startsWith("--rounds=")) {
			rounds = positiveInteger(arg.slice("--rounds=".length), rounds);
			continue;
		}
		if (arg.startsWith("--max-p95-ms=")) {
			maxP95Ms = positiveInteger(
				arg.slice("--max-p95-ms=".length),
				maxP95Ms,
			);
			continue;
		}
		throw new Error(`unknown argument: ${arg}`);
	}
	return { rounds, maxP95Ms };
}

function timestamp(): string {
	return new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function object(value: unknown): JsonObject {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: {};
}

export function evaluateIngestReliability(report: JsonObject): Gate {
	const jobs = object(report.jobs);
	const entries = Object.entries(jobs);
	if (entries.length === 0) {
		return { ok: false, failures: ["ingest report contains no jobs"] };
	}
	const failures = entries.flatMap(([filename, value]) => {
		const status = object(value).status;
		return status === "completed"
			? []
			: [`${filename}: ingest status ${String(status ?? "missing")}`];
	});
	return { ok: failures.length === 0, failures };
}

function markdown(report: JsonObject): string {
	const summary = object(report.summary);
	const gate = object(report.release_gate);
	const ingestGate = object(report.ingest_reliability_gate);
	const askGate = object(report.ask_stability_gate);
	const cases = Array.isArray(summary.cases)
		? summary.cases.map(object).filter((item) => item.passCount !== item.roundCount)
		: [];
	const lines = [
		`# UnoRAG Stability Evaluation ${report.run_id}`,
		"",
		`- release: \`${report.release}\``,
		`- gate: **${gate.ok === true ? "PASS" : "FAIL"}**`,
		`- ingest reliability: **${ingestGate.ok === true ? "PASS" : "FAIL"}**`,
		`- Ask stability: **${askGate.ok === true ? "PASS" : "FAIL"}**`,
		`- rounds: **${summary.passedRounds}/${summary.roundCount}**`,
		`- maximum round P95: **${summary.maxP95Ms} ms**`,
		`- model errors: **${summary.modelErrorCount}**`,
		`- fingerprint consistent: **${summary.fingerprintConsistent}**`,
		"",
		"## Unstable Cases",
		"",
	];
	if (cases.length === 0) lines.push("None.");
	else {
		lines.push("| case | kind | pass | stages |", "|---|---|---:|---|");
		for (const item of cases) {
			lines.push(
				`| ${item.caseId} | ${item.kind} | ${item.passCount}/${item.roundCount} | ${JSON.stringify(item.failureStages)} |`,
			);
		}
	}
	const failures = Array.isArray(gate.failures) ? gate.failures : [];
	if (failures.length > 0) {
		lines.push("", "## Gate Failures", "");
		for (const failure of failures) lines.push(`- ${failure}`);
	}
	return `${lines.join("\n")}\n`;
}

async function writeStabilityReport(report: JsonObject): Promise<string> {
	await mkdir(OUTPUT_DIR, { recursive: true, mode: 0o700 });
	await chmod(OUTPUT_DIR, 0o700);
	const suffix = String(report.run_id).replace(/^ab-stability-/u, "");
	const json = `${JSON.stringify(report, null, 2)}\n`;
	const md = markdown(report);
	const path = resolve(OUTPUT_DIR, `ab_stability_${suffix}.md`);
	for (const [target, content] of [
		[resolve(OUTPUT_DIR, `ab_stability_${suffix}.json`), json],
		[path, md],
		[resolve(OUTPUT_DIR, "ab_stability_latest.json"), json],
		[resolve(OUTPUT_DIR, "ab_stability_latest.md"), md],
	] as const) {
		await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
		await chmod(target, 0o600);
	}
	return path;
}

export async function runStabilityEvaluation(input: {
	rounds: number;
	maxP95Ms: number;
}): Promise<number> {
	const options = await resolveRunnerOptions([]);
	if (options.reuseLibraryId) {
		throw new Error(
			"UNORAG_AB_LIBRARY_ID is only supported by eval:live; stability owns its temporary corpus",
		);
	}
	const reports: JsonObject[] = [];
	let libraryId: string | null = null;
	let interruptedBy: NodeJS.Signals | null = null;
	const handleSignal = (signal: NodeJS.Signals) => {
		interruptedBy = signal;
		process.stderr.write(
			`!! ${signal} received; the current bounded operation will finish before cleanup\n`,
		);
	};
	process.once("SIGINT", handleSignal);
	process.once("SIGTERM", handleSignal);
	try {
		for (let round = 1; round <= input.rounds; round += 1) {
			if (interruptedBy) throw new Error(`interrupted by ${interruptedBy}`);
			process.stdout.write(`\n== stability round ${round}/${input.rounds}\n`);
			const code = await runLiveEvaluation({
				...options,
				keepLibrary: true,
				publishLangfuseScores: false,
				...(libraryId ? { reuseLibraryId: libraryId } : {}),
				onLibraryReady: (readyLibraryId) => {
					libraryId = readyLibraryId;
				},
			});
			if (code === 2) {
				throw new Error(`round ${round} ended with infrastructure error`);
			}
			reports.push(
				JSON.parse(
					await readFile(resolve(OUTPUT_DIR, "ab_live_latest.json"), "utf8"),
				) as JsonObject,
			);
			if (interruptedBy) throw new Error(`interrupted by ${interruptedBy}`);
		}
	} finally {
		process.removeListener("SIGINT", handleSignal);
		process.removeListener("SIGTERM", handleSignal);
		if (libraryId) {
			await cleanupEvaluationLibrary(options, libraryId);
			process.stdout.write(`== cleanup stability library ${libraryId} completed\n`);
		}
	}
	const summary = summarizeStability(reports, {
		expectedRounds: input.rounds,
		maxP95Ms: input.maxP95Ms,
	});
	const ingestReliabilityGate = evaluateIngestReliability(reports[0] ?? {});
	const askStabilityGate = summary.gate;
	const releaseGate: Gate = {
		ok: ingestReliabilityGate.ok && askStabilityGate.ok,
		failures: [
			...ingestReliabilityGate.failures,
			...askStabilityGate.failures,
		],
	};
	const report: JsonObject = {
		run_id: `ab-stability-${timestamp()}`,
		evaluated_at: new Date().toISOString(),
		release: options.release,
		options: input,
		rounds: reports.map((item) => ({
			run_id: item.run_id,
			summary: item.summary,
			release_gates: item.release_gates,
			build_fingerprint: item.build_fingerprint,
		})),
		summary,
		ingest_reliability_gate: ingestReliabilityGate,
		ask_stability_gate: askStabilityGate,
		release_gate: releaseGate,
	};
	const path = await writeStabilityReport(report);
	process.stdout.write(`== stability report ${path}\n`);
	process.stdout.write(
		`== ingest reliability gate ${ingestReliabilityGate.ok ? "PASS" : "FAIL"}\n`,
	);
	process.stdout.write(
		`== Ask stability gate ${askStabilityGate.ok ? "PASS" : "FAIL"}\n`,
	);
	process.stdout.write(`== release gate ${releaseGate.ok ? "PASS" : "FAIL"}\n`);
	return releaseGate.ok ? 0 : 1;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes("--help")) {
		process.stdout.write(
			"usage: pnpm eval:stability -- --rounds=3 --max-p95-ms=15000\n",
		);
		return;
	}
	try {
		process.exitCode = await runStabilityEvaluation(resolveStabilityOptions(args));
	} catch (error) {
		process.stderr.write(
			`FAIL: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 2;
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
