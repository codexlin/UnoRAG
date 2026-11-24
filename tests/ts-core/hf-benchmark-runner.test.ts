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

const reuseAndSubsetOfflineHttp = `
import { writeFileSync } from "node:fs";
const events = [];
const existingLibraries = JSON.parse(process.env.HF_TEST_LIBRARIES || "[]");
const existingDocs = JSON.parse(process.env.HF_TEST_DOCS || "{}");
process.on("exit", () => writeFileSync(process.env.HF_TEST_EVENTS, JSON.stringify(events)));
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).startsWith("http://hf-offline.invalid/")) throw new Error("unexpected network target");
  const path = new URL(url).pathname;
  const method = (init.method || "GET").toUpperCase();
  const json = (body, status = 200) => Response.json(body, { status });
  if (path === "/api/rag/health" || path === "/api/auth/session") return json({});
  if (path === "/api/libraries" && method === "GET") {
    events.push({ kind: "list_libraries" });
    return json(existingLibraries);
  }
  if (path === "/api/libraries" && method === "POST") {
    const body = JSON.parse(init.body);
    events.push({ kind: "create_library", name: body.name });
    return json({ id: "created-reusable-lib", name: body.name }, 201);
  }
  const docMatch = path.match(/^\\/api\\/libraries\\/([^/]+)\\/documents$/);
  if (docMatch && method === "GET") {
    const libId = decodeURIComponent(docMatch[1]);
    events.push({ kind: "list_documents", libraryId: libId });
    return json(existingDocs[libId] || []);
  }
  if (docMatch && method === "POST") {
    const libId = decodeURIComponent(docMatch[1]);
    events.push({ kind: "upload", libraryId: libId });
    return json({ job_id: "offline-job" }, 202);
  }
  if (path === "/api/jobs/offline-job") return json({ status: "completed" });
  if (path === "/api/rag/v1/ask") {
    const { question } = JSON.parse(init.body);
    events.push({ kind: "ask", question });
    return json({
      answer: "42 [1]",
      refused: question.startsWith("negative"),
      refuse_reason: question.startsWith("negative") ? "insufficient_evidence" : null,
      citations: question.startsWith("negative") ? [] : [{ filename: "fixture.pdf" }],
    });
  }
  if (method === "DELETE") {
    events.push({ kind: "delete_library", path });
    return json({}, 200);
  }
  throw new Error("unexpected offline request: " + method + " " + path);
};
`;

async function runCliWithArgs(input: {
	directory: string;
	extraArgs: readonly string[];
	libraries?: unknown[];
	docsByLibrary?: Record<string, unknown[]>;
}) {
	const beforeReports = new Set(
		await readdir(resolve(input.directory, "reports")).catch(() => []),
	);
	const eventsPath = resolve(
		input.directory,
		`events-${Date.now()}-${Math.random()}.json`,
	);
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			"--import",
			`data:text/javascript,${encodeURIComponent(reuseAndSubsetOfflineHttp)}`,
			"scripts/evaluation/run-hf-benchmark.ts",
			"--dir",
			input.directory,
			...input.extraArgs,
		],
		{
			timeout: 15_000,
			env: {
				...process.env,
				UNORAG_BASE_URL: "http://hf-offline.invalid",
				UNORAG_ADMIN_PASSWORD: "offline-only",
				HF_TEST_EVENTS: eventsPath,
				HF_TEST_LIBRARIES: JSON.stringify(input.libraries ?? []),
				HF_TEST_DOCS: JSON.stringify(input.docsByLibrary ?? {}),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const code = await new Promise<number | null>((resolveExit, reject) => {
		child.on("error", reject);
		child.on("close", resolveExit);
	});
	const events = JSON.parse(
		await readFile(eventsPath, "utf8").catch(() => "[]"),
	) as Array<Record<string, unknown>>;
	const reports = (
		await readdir(resolve(input.directory, "reports")).catch(() => [])
	)
		.filter((name) => name.endsWith(".json") && !beforeReports.has(name))
		.sort();
	const latestReport = reports.at(-1)
		? JSON.parse(
				await readFile(
					resolve(input.directory, "reports", reports.at(-1) as string),
					"utf8",
				),
			)
		: null;
	return { code, stdout, stderr, events, report: latestReport };
}

async function createOfflineBatchFixture(): Promise<string> {
	const directory = await mkdtemp(resolve(tmpdir(), "hf-reuse-subset-"));
	await mkdir(resolve(directory, "pdfs"));
	await writeFile(resolve(directory, "pdfs/fixture.pdf"), "offline fixture");
	const cases = ["positive", "negative"].flatMap((polarity) =>
		Array.from({ length: 4 }, (_, index) => ({
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
	return directory;
}

test("HF CLI --reuse-or-create persists reusable ID once and skips upload on subsequent runs", async () => {
	const directory = await createOfflineBatchFixture();
	try {
		// 1st run: creates library, uploads corpus once, saves reusable-library-id.txt, does not delete.
		const first = await runCliWithArgs({
			directory,
			extraArgs: [
				"--reuse-or-create",
				"Benchmark Corpus",
				"--only-ids",
				"positive-0",
			],
		});
		assert.equal(first.code, 0, first.stderr);
		assert.equal(
			first.events.filter((e) => e.kind === "create_library").length,
			1,
		);
		assert.equal(first.events.filter((e) => e.kind === "upload").length, 1);
		assert.equal(
			first.events.filter((e) => e.kind === "delete_library").length,
			0,
		);
		assert.equal(
			(
				await readFile(resolve(directory, "reusable-library-id.txt"), "utf8")
			).trim(),
			"created-reusable-lib",
		);
		assert.equal(first.report.reused_library, false);
		assert.deepEqual(
			first.report.positive_results.map((r: { id: string }) => r.id),
			["positive-0"],
		);
		assert.equal(first.report.negative_results.length, 0);
		assert.deepEqual(first.report.subset, {
			only_ids: ["positive-0"],
			total_positive_cases: 4,
			total_negative_cases: 4,
		});

		// 2nd run: reuses saved library ID with zero uploads and zero library creations.
		const second = await runCliWithArgs({
			directory,
			extraArgs: [
				"--reuse-or-create",
				"Benchmark Corpus",
				"--only-ids",
				"positive-2,negative-1",
			],
			docsByLibrary: {
				"created-reusable-lib": [
					{ filename: "fixture.pdf", status: "ready", job_status: "completed" },
				],
			},
		});
		assert.equal(second.code, 0, second.stderr);
		assert.equal(
			second.events.filter((e) => e.kind === "create_library").length,
			0,
		);
		assert.equal(second.events.filter((e) => e.kind === "upload").length, 0);
		assert.equal(second.report.reused_library, true);
		assert.equal(second.report.library_id, "created-reusable-lib");
		assert.deepEqual(
			second.events.filter((e) => e.kind === "ask").map((e) => e.question),
			["positive-2", "negative-1"],
		);

		// 3rd run: discovers existing ready named library even without saved file.
		await rm(resolve(directory, "reusable-library-id.txt"), { force: true });
		const third = await runCliWithArgs({
			directory,
			extraArgs: [
				"--reuse-or-create",
				"Benchmark Corpus",
				"--only-ids",
				"positive-1",
			],
			libraries: [
				{ id: "named-ready-lib", name: "Benchmark Corpus", status: "ready" },
			],
			docsByLibrary: {
				"named-ready-lib": [
					{ filename: "fixture.pdf", status: "ready", job_status: "completed" },
				],
			},
		});
		assert.equal(third.code, 0, third.stderr);
		assert.equal(third.events.filter((e) => e.kind === "upload").length, 0);
		assert.equal(third.report.library_id, "named-ready-lib");
		assert.equal(third.report.reused_library, true);
		assert.equal(
			(
				await readFile(resolve(directory, "reusable-library-id.txt"), "utf8")
			).trim(),
			"named-ready-lib",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("HF CLI --only-failed-from reruns only failed/non-correct cases and exits cleanly when 0 failed", async () => {
	const directory = await createOfflineBatchFixture();
	try {
		const priorPath = resolve(directory, "prior-report.json");
		await writeFile(
			priorPath,
			JSON.stringify({
				positive_results: [
					{
						id: "positive-0",
						http_status: 200,
						answered: true,
						doc_recall: true,
						semantic_verdict: "correct",
					},
					{
						id: "positive-1",
						http_status: 200,
						answered: true,
						doc_recall: true,
						semantic_verdict: "partial",
					},
					{
						id: "positive-2",
						http_status: 503,
						answered: false,
						doc_recall: false,
					},
					{
						id: "positive-3",
						http_status: 200,
						answered: true,
						doc_recall: false,
						semantic_verdict: "correct",
					},
				],
				negative_results: [
					{ id: "negative-0", http_status: 200, passed: true },
					{ id: "negative-1", http_status: 200, passed: false },
				],
			}),
		);
		const rerun = await runCliWithArgs({
			directory,
			extraArgs: [
				"--reuse-library",
				"existing-lib",
				"--only-failed-from",
				priorPath,
			],
			docsByLibrary: {
				"existing-lib": [
					{ filename: "fixture.pdf", status: "ready", job_status: "completed" },
				],
			},
		});
		assert.equal(rerun.code, 0, rerun.stderr);
		assert.deepEqual(
			rerun.events.filter((e) => e.kind === "ask").map((e) => e.question),
			["positive-1", "positive-2", "positive-3", "negative-1"],
		);
		assert.equal(rerun.report.subset.only_failed_from, priorPath);

		// Clean prior report with 0 failures exits 0 without calling Ask.
		const cleanPath = resolve(directory, "clean-report.json");
		await writeFile(
			cleanPath,
			JSON.stringify({
				positive_results: [
					{
						id: "positive-0",
						http_status: 200,
						answered: true,
						doc_recall: true,
						semantic_verdict: "correct",
					},
				],
				negative_results: [
					{ id: "negative-0", http_status: 200, passed: true },
				],
			}),
		);
		const zeroFail = await runCliWithArgs({
			directory,
			extraArgs: [
				"--reuse-library",
				"existing-lib",
				"--only-failed-from",
				cleanPath,
			],
		});
		assert.equal(zeroFail.code, 0, zeroFail.stderr);
		assert.match(zeroFail.stdout, /0 failed cases/);
		assert.equal(zeroFail.events.filter((e) => e.kind === "ask").length, 0);

		// Mutually exclusive flags fail closed.
		const invalid = await runCliWithArgs({
			directory,
			extraArgs: ["--reuse-or-create", "--cleanup-library"],
		});
		assert.equal(invalid.code, 1);
		assert.match(
			invalid.stderr,
			/cannot combine --reuse-or-create and --cleanup-library/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
