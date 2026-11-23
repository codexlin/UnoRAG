import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

// Preload only the HTTP boundary; execute the real CLI, scoring and cleanup.
const offlineHttp = `
import { writeFileSync } from "node:fs";
const events = [];
let active = 0;
const mode = process.env.HF_TEST_MODE;
const phase = process.env.HF_TEST_PHASE;
process.on("exit", () => writeFileSync(process.env.HF_TEST_EVENTS, JSON.stringify(events)));
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).startsWith("http://hf-offline.invalid/")) throw new Error("unexpected network target");
  const path = new URL(url).pathname;
  const json = (body, status = 200) => Response.json(body, { status });
  if (path === "/api/rag/health" || path === "/api/auth/session") return json({});
  if (path === "/api/libraries" && init.method === "POST") return json({ id: "offline-library" }, 201);
  if (path.endsWith("/documents")) return json({ job_id: "offline-job" }, 202);
  if (path === "/api/jobs/offline-job") return json({ status: "completed" });
  if (path === "/api/rag/v1/ask") {
    const { question } = JSON.parse(init.body);
    active++;
    events.push({ kind: "start", question, active });
    try {
      if (mode === "refusal-scoring" && question.startsWith("negative")) {
        const reason = question === "negative-0" ? "judge_unavailable"
          : question === "negative-1" ? "invalid_evidence_selection" : "insufficient_evidence";
        return json({ answer: "", refused: true, refuse_reason: reason, citations: [] });
      }
      if (question.startsWith(phase)) {
        const index = Number(question.split("-")[1]);
        await new Promise(resolve => setTimeout(resolve, [20, 60, 100][index] ?? 1));
        if (mode !== "http" && index === 0) throw new Error("original-worker-failure");
        if (mode !== "http" && mode !== "single-failure" && index === 2) throw new Error("later-worker-failure");
        if (mode === "http" && index === 0) return json({ detail: "unavailable" }, 503);
      }
      return json({ answer: "42 [1]", refused: question.startsWith("negative"), citations: [{ filename: "fixture.pdf" }] });
    } finally {
      active--;
      events.push({ kind: "settle", question, active });
    }
  }
  if (init.method === "DELETE") {
    events.push({ kind: "cleanup", active });
    return json({}, mode === "cleanup-failure" || mode === "cleanup-only-failure" ? 503 : 200);
  }
  if (path === "/api/libraries") return json([]);
  throw new Error("unexpected offline request: " + path);
};
`;

async function execute(mode: string, phase = "positive") {
	const directory = await mkdtemp(resolve(tmpdir(), "hf-runner-"));
	try {
		await mkdir(resolve(directory, "pdfs"));
		await writeFile(resolve(directory, "pdfs/fixture.pdf"), "offline fixture");
		const cases = ["positive", "negative"].flatMap((polarity) =>
			Array.from({ length: 6 }, (_, index) => ({
				id: `${polarity}-${index}`,
				polarity,
				question: `${polarity}-${index}`,
				file: "fixture.pdf",
				source_doc: "fixture.pdf",
				gold: ["42"],
				expected_numbers: ["42"],
				expected_terms: [],
				task_type: "offline",
				doc_type: "fixture",
			})),
		);
		await writeFile(
			resolve(directory, "cases.jsonl"),
			cases.map((item) => JSON.stringify(item)).join("\n"),
		);
		const eventsPath = resolve(directory, "events.json");
		const child = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				"--import",
				`data:text/javascript,${encodeURIComponent(offlineHttp)}`,
				"scripts/evaluation/run-hf-benchmark.ts",
				"--dir",
				directory,
				"--concurrency",
				"3",
				"--cleanup-library",
			],
			{
				timeout: 15_000,
				env: {
					...process.env,
					UNORAG_BASE_URL: "http://hf-offline.invalid",
					UNORAG_ADMIN_PASSWORD: "offline-only",
					HF_TEST_EVENTS: eventsPath,
					HF_TEST_MODE: mode,
					HF_TEST_PHASE: mode === "cleanup-only-failure" ? "none" : phase,
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stderr = "";
		child.stdout.resume();
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const code = await new Promise<number | null>((resolveExit, reject) => {
			child.on("error", reject);
			child.on("close", resolveExit);
		});
		const events = JSON.parse(await readFile(eventsPath, "utf8")) as Array<{
			kind: string;
			question?: string;
			active: number;
		}>;
		const reports = await readdir(resolve(directory, "reports")).catch(
			() => [],
		);
		const reportPath = reports.find((name) => name.endsWith(".json"));
		const report = reportPath
			? JSON.parse(
					await readFile(resolve(directory, "reports", reportPath), "utf8"),
				)
			: null;
		return { code, stderr, events, report };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

for (const phase of ["positive", "negative"]) {
	for (const mode of ["single-failure", "failure", "cleanup-failure"]) {
		test(`HF CLI drains ${phase} workers before cleanup and preserves the first error (${mode})`, async () => {
			const result = await execute(mode, phase);
			assert.equal(result.code, 1);
			assert.match(result.stderr, /FAIL: Error: original-worker-failure/);
			assert.deepEqual(
				result.events.filter((event) => event.kind === "cleanup"),
				[{ kind: "cleanup", active: 0 }],
			);
			assert.deepEqual(
				result.events
					.filter(
						(event) =>
							event.kind === "start" && event.question?.startsWith(phase),
					)
					.map((event) => event.question),
				[`${phase}-0`, `${phase}-1`, `${phase}-2`],
			);
			assert.equal(result.events.at(-1)?.kind, "cleanup");
			assert.equal(result.report, null);
			if (phase === "positive")
				assert.ok(
					!result.events.some((event) =>
						event.question?.startsWith("negative"),
					),
				);
		});
	}
}

for (const phase of ["positive", "negative"]) {
	test(`HF CLI records ${phase} HTTP non-200 results without stopping dispatch`, async () => {
		const result = await execute("http", phase);
		assert.equal(result.code, 0, result.stderr);
		assert.equal(
			result.events.filter((event) => event.kind === "start").length,
			12,
		);
		const rows =
			phase === "positive"
				? result.report.positive_results
				: result.report.negative_results;
		assert.equal(rows[0].http_status, 503);
		assert.equal(
			phase === "positive" ? rows[0].answered : rows[0].passed,
			false,
		);
		assert.deepEqual(
			result.report.positive_results.map((row: { id: string }) => row.id),
			Array.from({ length: 6 }, (_, index) => `positive-${index}`),
		);
		assert.deepEqual(result.events.at(-1), { kind: "cleanup", active: 0 });
	});
}

test("HF CLI still fails on cleanup errors after a successful evaluation", async () => {
	const result = await execute("cleanup-only-failure");
	assert.equal(result.code, 1);
	assert.match(
		result.stderr,
		/FAIL: Error: evaluation library cleanup failed: HTTP 503/,
	);
	assert.ok(result.report);
});

test("HF CLI fails HTTP 200 technical refusals but accepts insufficient evidence refusals", async () => {
	const result = await execute("refusal-scoring", "none");
	assert.equal(result.code, 0, result.stderr);
	const rows = result.report.negative_results;
	assert.equal(rows.length, 6);
	for (const row of rows) {
		assert.equal(row.http_status, 200);
		assert.equal(row.refused, true);
	}
	assert.equal(rows[0].refuse_reason, "judge_unavailable");
	assert.equal(rows[0].passed, false);
	assert.equal(rows[1].refuse_reason, "invalid_evidence_selection");
	assert.equal(rows[1].passed, false);
	for (const row of rows.slice(2)) {
		assert.equal(row.refuse_reason, "insufficient_evidence");
		assert.equal(row.passed, true);
	}
	assert.equal(result.report.summary.negative_cases, 6);
	assert.equal(result.report.summary.negative_passed, 4);
	assert.equal(result.report.summary.refusal_accuracy, 4 / 6);
	assert.equal(
		result.events.filter((event) => event.kind === "start").length,
		12,
	);
	assert.deepEqual(result.events.at(-1), { kind: "cleanup", active: 0 });
});
