import assert from "node:assert/strict";
import {
	chmod,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
	resolveRunnerOptions,
	runLiveEvaluation,
	validateServiceUrl,
} from "../../scripts/run-ab-live-e2e";
import { loadGoldenJsonl, loadNegativeGoldenJsonl } from "../../src/evaluation";

const ENV_KEYS = [
	"UNORAG_ADMIN_EMAIL",
	"UNORAG_ADMIN_PASSWORD",
	"UNORAG_AB_PASSWORD_FILE",
	"UNORAG_BASE_URL",
	"UNORAG_AB_KEEP_LIBRARY",
	"UNORAG_AB_JOB_TIMEOUT_SEC",
	"UNORAG_AB_ASK_TIMEOUT_SEC",
	"UNORAG_AB_POLL_INTERVAL_MS",
	"UNORAG_AB_CLEANUP_TIMEOUT_SEC",
	"UNORAG_EVAL_RELEASE",
] as const;

function withEnvironment(
	values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
	operation: () => Promise<void>,
): Promise<void> {
	const original = Object.fromEntries(
		ENV_KEYS.map((key) => [key, process.env[key]]),
	) as Record<(typeof ENV_KEYS)[number], string | undefined>;
	for (const key of ENV_KEYS) {
		const value = values[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	return operation().finally(() => {
		for (const key of ENV_KEYS) {
			const value = original[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
}

test("live evaluation CLI is explicit, bounded, and repository-versioned", async () => {
	await withEnvironment(
		{
			UNORAG_ADMIN_EMAIL: "admin@example.com",
			UNORAG_ADMIN_PASSWORD: "test-password",
			UNORAG_BASE_URL: "http://127.0.0.1:3000/",
			UNORAG_AB_JOB_TIMEOUT_SEC: "30",
			UNORAG_AB_ASK_TIMEOUT_SEC: "20",
			UNORAG_AB_POLL_INTERVAL_MS: "25",
			UNORAG_EVAL_RELEASE: "release-test",
		},
		async () => {
			const options = await resolveRunnerOptions([
				"--keep-library",
				"--publish-langfuse-scores",
			]);
			assert.deepEqual(options, {
				baseUrl: "http://127.0.0.1:3000",
				email: "admin@example.com",
				password: "test-password",
				keepLibrary: true,
				publishLangfuseScores: true,
				jobTimeoutMs: 30_000,
				askTimeoutMs: 20_000,
				pollIntervalMs: 25,
				cleanupTimeoutMs: 120_000,
				release: "release-test",
			});
		},
	);
});

test("evaluation endpoints require HTTPS except for loopback", () => {
	assert.equal(
		validateServiceUrl("http://127.0.0.1:3000/", "test"),
		"http://127.0.0.1:3000",
	);
	assert.equal(
		validateServiceUrl("https://kb.example.com/", "test"),
		"https://kb.example.com",
	);
	assert.throws(
		() => validateServiceUrl("http://kb.example.com", "test"),
		/HTTPS/,
	);
	assert.throws(
		() => validateServiceUrl("https://user:secret@kb.example.com", "test"),
		/credentials/,
	);
});

test("password files must be private and support home-independent absolute paths", async () => {
	const directory = await mkdtemp(resolve(tmpdir(), "unorag-eval-"));
	const passwordPath = resolve(directory, "password");
	try {
		await writeFile(passwordPath, "file-password\n", { mode: 0o644 });
		await withEnvironment(
			{
				UNORAG_ADMIN_EMAIL: "admin@example.com",
				UNORAG_AB_PASSWORD_FILE: passwordPath,
			},
			async () => {
				await assert.rejects(resolveRunnerOptions([]), /group\/world/);
			},
		);
		await chmod(passwordPath, 0o600);
		await withEnvironment(
			{
				UNORAG_ADMIN_EMAIL: "admin@example.com",
				UNORAG_AB_PASSWORD_FILE: passwordPath,
				UNORAG_EVAL_RELEASE: "release-test",
			},
			async () => {
				assert.equal(
					(await resolveRunnerOptions([])).password,
					"file-password",
				);
			},
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("live runner exercises login, upload, jobs, asks, strict gates, reports, and cleanup", async () => {
	const root = resolve(import.meta.dirname, "../..");
	const [golds, negatives] = await Promise.all([
		loadGoldenJsonl(resolve(root, "testdata/ab/golds.jsonl")),
		loadNegativeGoldenJsonl(resolve(root, "testdata/ab/negative-golds.jsonl")),
	]);
	const positiveByQuestion = new Map(
		golds.map((item) => [item.question, item] as const),
	);
	const negativeQuestions = new Set(negatives.map((item) => item.question));
	let uploads = 0;
	let asks = 0;
	let deleted = false;
	let authenticatedRequests = 0;
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const send = (status: number, body: unknown, headers = {}) => {
			response.writeHead(status, {
				"content-type": "application/json",
				...headers,
			});
			response.end(JSON.stringify(body));
		};
		if (request.method === "GET" && url.pathname === "/api/rag/health") {
			send(200, { status: "ok" });
			return;
		}
		if (request.method === "POST" && url.pathname === "/api/auth/session") {
			send(
				200,
				{ ok: true },
				{ "set-cookie": "unorag_session=test; Secure; HttpOnly" },
			);
			return;
		}
		if (!request.headers.cookie?.includes("unorag_session=test")) {
			send(401, { detail: "authentication required" });
			return;
		}
		authenticatedRequests += 1;
		if (request.method === "POST" && url.pathname === "/api/libraries") {
			send(201, { id: "library-eval" });
			return;
		}
		if (
			request.method === "POST" &&
			url.pathname === "/api/libraries/library-eval/documents"
		) {
			uploads += 1;
			request.resume();
			send(202, { job_id: `job-${uploads}`, document_id: `doc-${uploads}` });
			return;
		}
		if (request.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
			send(200, { status: "completed", stage: "done" });
			return;
		}
		if (request.method === "POST" && url.pathname === "/api/rag/v1/ask") {
			let raw = "";
			for await (const chunk of request) raw += String(chunk);
			const payload = JSON.parse(raw) as {
				question: string;
				session_id: string;
			};
			asks += 1;
			const gold = positiveByQuestion.get(payload.question);
			if (gold) {
				send(200, {
					answer: gold.answer,
					refused: false,
					trace_id: `request-${asks}`,
					session_id: payload.session_id,
					retrieval_debug: {
						total_duration_ms: 12.5,
						stages: [{ stage: "retrieve", duration_ms: 3.5, ok: true }],
					},
					citations: [
						{ filename: gold.file, record_type: gold.expect_record_type },
					],
				});
				return;
			}
			if (negativeQuestions.has(payload.question)) {
				send(200, {
					answer: "资料未覆盖",
					refused: true,
					trace_id: `request-${asks}`,
					session_id: payload.session_id,
					citations: [],
				});
				return;
			}
			send(400, { detail: "unknown evaluation question" });
			return;
		}
		if (
			request.method === "DELETE" &&
			url.pathname === "/api/libraries/library-eval"
		) {
			deleted = true;
			send(202, { status: "deleting" });
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/libraries") {
			send(200, deleted ? [] : [{ id: "library-eval", status: "ready" }]);
			return;
		}
		send(404, { detail: "not found" });
	});
	await new Promise<void>((resolveListen) =>
		server.listen(0, "127.0.0.1", resolveListen),
	);
	try {
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const result = await runLiveEvaluation({
			baseUrl: `http://127.0.0.1:${address.port}`,
			email: "admin@example.com",
			password: "test-password",
			keepLibrary: false,
			publishLangfuseScores: false,
			jobTimeoutMs: 1_000,
			askTimeoutMs: 1_000,
			pollIntervalMs: 1,
			cleanupTimeoutMs: 1_000,
			release: "test-release",
		});
		assert.equal(result, 0);
		assert.equal(uploads, 7);
		assert.equal(asks, 38);
		assert.equal(deleted, true);
		assert.ok(authenticatedRequests > asks);
		const output = resolve(root, "testdata/ab/_e2e_out");
		assert.equal((await stat(output)).mode & 0o777, 0o700);
		assert.equal(
			(await stat(resolve(output, "ab_live_latest.json"))).mode & 0o777,
			0o600,
		);
		const report = JSON.parse(
			await readFile(resolve(output, "ab_live_latest.json"), "utf8"),
		) as {
			release_gates: { ok: boolean };
			positive_cases: Array<{
				response: { retrievalDebug?: Record<string, unknown> | null };
			}>;
		};
		assert.equal(report.release_gates.ok, true);
		assert.deepEqual(report.positive_cases[0]?.response.retrievalDebug, {
			total_duration_ms: 12.5,
			stages: [{ stage: "retrieve", duration_ms: 3.5, ok: true }],
		});
	} finally {
		await new Promise<void>((resolveClose, reject) =>
			server.close((error) => (error ? reject(error) : resolveClose())),
		);
	}
});

test("live evaluation CLI fails closed on credentials and unknown options", async () => {
	await withEnvironment({}, async () => {
		await assert.rejects(resolveRunnerOptions([]), /credentials|required/i);
	});
	await withEnvironment(
		{
			UNORAG_ADMIN_EMAIL: "admin@example.com",
			UNORAG_ADMIN_PASSWORD: "test-password",
		},
		async () => {
			await assert.rejects(resolveRunnerOptions(["--surprise"]), /unknown/);
			await assert.rejects(resolveRunnerOptions(["--help"]), /usage:/);
		},
	);
});
