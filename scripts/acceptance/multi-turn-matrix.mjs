import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	assertArchiveTurns,
	blocked,
	configurationFingerprint,
	EXPIRY_MS,
	loadMultiTurnPlan,
	matrixOptions,
	privateOutputDirectory,
	ROOT,
	scoreTurn,
	validateIdentity,
} from "./lib/multi-turn-contract.mjs";
import { EXIT_BLOCKED, redactText, redactValue } from "./lib/runtime.mjs";
import {
	deleteLibraryAndWait,
	ProductSession,
	waitForJob,
} from "./recovery-probe.mjs";

const exec = promisify(execFile);
const id = (value) => {
	assert.ok(
		typeof value === "string" && /^[a-zA-Z0-9-]{1,128}$/u.test(value),
		"invalid product identifier",
	);
	return value;
};

export function planSummary(plan, options) {
	return {
		mode: options.development ? "development" : "release",
		result: "PLAN_ONLY",
		release_gate: "not_evaluated",
		manifest_sha256: plan.sha256,
		contract_version: plan.contract_version,
		include_expiry: options.includeExpiry,
		expiry_wait_ms: options.includeExpiry ? EXPIRY_MS + 1_000 : 0,
		documents: plan.documents.map(({ id, file, sha256 }) => ({
			id,
			file,
			sha256,
		})),
		scenarios: plan.scenarios.map((s) => ({
			id: s.id,
			steps: s.steps.length,
			selected: !s.expiry || options.includeExpiry,
		})),
		deterministic_coverage: plan.deterministic_coverage,
		limitations: [
			"Synthetic fixtures are not customer-corpus quality evidence.",
			"Permission revocation is NOT run live; consult the listed deterministic suites.",
			"Archived synthetic threads follow product retention; no public thread-delete API exists.",
		],
		writes:
			"Only newly created run-id libraries, their documents, sessions and archives. No model/configuration changes.",
		output_root: options.outputDirectory,
	};
}

async function localIdentity() {
	const { stdout: revision } = await exec("git", ["rev-parse", "HEAD"], {
		cwd: ROOT,
	});
	const { stdout: status } = await exec("git", ["status", "--porcelain"], {
		cwd: ROOT,
	});
	return { revision: revision.trim(), dirty: status.trim().length > 0 };
}

// The registry accepts only IDs returned by this run's create operation. There
// is deliberately no CLI library ID, keep-library mode, or cleanup-by-prefix.
export class OwnedLibraries {
	constructor(client, runId, onChange = async () => {}) {
		this.client = client;
		this.runId = runId;
		this.items = [];
		this.onChange = onChange;
	}
	async create(label) {
		assert.ok(["main", "isolated", "lifecycle"].includes(label));
		const name = `${this.runId} ${label}`;
		const library = await this.client.request("/api/libraries", {
			method: "POST",
			body: { name },
			expected: [200, 201],
		});
		const item = { id: id(library.id), label, name };
		this.items.push(item);
		await this.onChange(this.items);
		return item.id;
	}
	assertOwned(libraryId) {
		assert.ok(
			this.items.some((item) => item.id === libraryId),
			"refusing to mutate an unowned library",
		);
	}
	async cleanup(timeoutMs, onResult = async () => {}) {
		const results = [];
		for (const item of [...this.items].reverse()) {
			try {
				await deleteLibraryAndWait(this.client, item.id, timeoutMs);
				results.push({ id: item.id, result: "PASS" });
			} catch {
				results.push({
					id: item.id,
					result: "FAIL",
					error: "owned library cleanup failed; inspect private HTTP evidence",
				});
			}
			await onResult(results);
		}
		return results;
	}
}

export async function runMultiTurnMatrix(options, password, { signal } = {}) {
	const plan = await loadMultiTurnPlan();
	const runId = `multi-turn-${new Date().toISOString().replace(/[-:.]/gu, "")}-${randomUUID().slice(0, 8)}`;
	const output = await privateOutputDirectory(options.outputDirectory, runId);
	await mkdir(resolve(output, "raw"), { mode: 0o700 });
	const report = {
		schema_version: 1,
		run_id: runId,
		started_at: new Date().toISOString(),
		...planSummary(plan, options),
		result: "RUNNING",
		target: new URL(options.baseUrl).origin,
		local_identity: null,
		runtime_identity: null,
		runtime_identity_after: null,
		configuration: null,
		configuration_after: null,
		owned_libraries: [],
		owned_threads: [],
		sources: [],
		jobs: [],
		responses: [],
		scenarios: [],
		cleanup: [],
	};
	const client = new ProductSession(report.target);
	const safe = (value) =>
		redactText(JSON.stringify(redactValue(value), null, 2), [
			password,
			client.cookie,
		]);
	const save = () =>
		writeFile(resolve(output, "report.json"), `${safe(report)}\n`, {
			mode: 0o600,
		});
	const owned = new OwnedLibraries(client, runId, async (items) => {
		report.owned_libraries = items;
		await save();
	});
	const requestDetailed = client.requestDetailed.bind(client);
	let sequence = 0,
		cleaningUp = false;
	client.requestDetailed = async (path, request = {}) => {
		if (!cleaningUp && signal?.aborted)
			throw new Error("acceptance interrupted");
		const started = performance.now();
		const result = await requestDetailed(path, {
			...request,
			expected: Array.from({ length: 500 }, (_, i) => i + 100),
		});
		if (path !== "/api/auth/session") {
			const filename = `raw/${String(++sequence).padStart(5, "0")}.json`;
			const requestId =
				result.headers.get("x-request-id") ?? result.body?.trace_id ?? null;
			await writeFile(
				resolve(output, filename),
				`${safe({
					path,
					method: request.method ?? "GET",
					request:
						request.body instanceof FormData
							? { multipart: true }
							: request.body,
					status: result.status,
					request_id: requestId,
					duration_ms: Math.round(performance.now() - started),
					body:
						path === "/api/libraries" &&
						(!request.method || request.method === "GET")
							? {
									valid_list: Array.isArray(result.body),
									owned_library_ids: Array.isArray(result.body)
										? result.body
												.filter((item) =>
													owned.items.some((own) => own.id === item?.id),
												)
												.map((item) => item.id)
										: [],
								}
							: result.body,
				})}\n`,
				{ mode: 0o600 },
			);
			report.responses.push({
				file: filename,
				path,
				status: result.status,
				request_id: requestId,
			});
			await save();
		}
		assert.ok(
			(request.expected ?? [200]).includes(result.status),
			`HTTP ${result.status} from ${path}`,
		);
		return result;
	};
	let exitCode = 0;
	try {
		report.local_identity = await localIdentity();
		const health = await client.request("/api/rag/health/ready", {
			expected: [200, 503],
		});
		report.runtime_identity = health.release;
		validateIdentity(options, report.local_identity, health);
		report.configuration = configurationFingerprint(health);
		const authentication = await client.requestDetailed("/api/auth/session", {
			method: "POST",
			body: { email: options.email, password },
			expected: [200, 401, 403, 429],
		});
		if (authentication.status !== 200)
			throw blocked(`login returned HTTP ${authentication.status}`);
		const login = authentication.body;
		if (login?.mustChangePassword)
			throw blocked("change the bootstrap password before acceptance");
		const libraries = {};
		for (const label of ["main", "isolated", "lifecycle"])
			libraries[label] = await owned.create(label);
		const sources = { main: {}, isolated: {}, lifecycle: {} };
		async function upload(label, fixtureId, previous) {
			const libraryId = libraries[label];
			owned.assertOwned(libraryId);
			const fixture = plan.documents.find((d) => d.id === fixtureId);
			assert.ok(fixture);
			const form = new FormData();
			form.set(
				"file",
				new Blob([fixture.bytes], { type: "text/markdown" }),
				fixture.file,
			);
			const accepted = await client.request(
				`/api/libraries/${libraryId}/documents${previous ? `/${id(previous.document_id)}/versions` : ""}`,
				{ method: "POST", body: form, expected: [202] },
			);
			report.jobs.push({
				operation: previous ? "replace" : "upload",
				library_id: libraryId,
				fixture: fixtureId,
				accepted,
			});
			await save();
			const job = await waitForJob(client, id(accepted.job_id), 900_000);
			report.jobs.at(-1).terminal = job.status;
			assert.equal(job.status, "completed", "ingestion must complete");
			const versions = await client.request(
				`/api/libraries/${libraryId}/documents/${id(accepted.document_id)}/versions`,
			);
			const active = versions.versions?.find(
				(v) => v.id === versions.active_version_id,
			);
			assert.ok(active?.generation_id, "active generation identity missing");
			assert.equal(versions.active_version_id, accepted.document_version_id);
			if (previous)
				assert.notEqual(previous.version_id, versions.active_version_id);
			const source = {
				fixture: fixtureId,
				library_id: libraryId,
				document_id: accepted.document_id,
				version_id: versions.active_version_id,
				generation_id: active.generation_id,
				sha256: fixture.sha256,
			};
			sources[label][fixtureId] = source;
			report.sources.push(source);
			await save();
			return source;
		}
		await upload("main", "a");
		await upload("main", "b");
		await upload("lifecycle", "a");
		for (const scenario of plan.scenarios) {
			const row = { id: scenario.id, result: "RUNNING", steps: [] };
			report.scenarios.push(row);
			if (scenario.expiry && !options.includeExpiry) {
				row.result = "NOT_RUN_DEVELOPMENT_ONLY";
				await save();
				continue;
			}
			const sessionId = `${runId}-${scenario.id}`;
			let threadId,
				choices = [],
				archivedTurns = [],
				pendingObservedAt;
			const turns = [];
			async function reload() {
				assert.ok(threadId);
				for (const suffix of ["", "/continue"]) {
					const body = await client.request(
						`/api/rag/v1/threads/${id(threadId)}${suffix}`,
						{ method: suffix ? "POST" : "GET" },
					);
					assert.equal(body.id, threadId);
					assertArchiveTurns(body, archivedTurns, libraries[scenario.library]);
				}
			}
			try {
				for (const step of scenario.steps) {
					const result = { op: step.op, result: "RUNNING" };
					row.steps.push(result);
					if (signal?.aborted) throw new Error("acceptance interrupted");
					if (step.op === "ask") {
						const label = step.library ?? scenario.library;
						const request = {
							library_id: libraries[label],
							question: step.question,
							session_id:
								step.context === "fresh" || step.context === "archive"
									? `${runId}-${randomUUID()}`
									: sessionId,
							...(step.context === "archive" ? { thread_id: threadId } : {}),
						};
						const response = await client.requestDetailed("/api/rag/v1/ask", {
							method: "POST",
							body: request,
							timeoutMs: 120_000,
						});
						const requestId =
							response.headers.get("x-request-id") ??
							response.body?.trace_id ??
							null;
						const score = scoreTurn(
							step.expect,
							{ ...response, requestId },
							{
								documents: plan.documents,
								sources: sources[label],
								choices,
								requirePersistence: step.context === "archive",
							},
						);
						Object.assign(result, {
							question: step.question,
							request_id: requestId,
							raw: report.responses.at(-1)?.file,
							score,
						});
						assert.ok(
							score.ok,
							`strict turn score failed: ${score.failures.join(",")}`,
						);
						if (score.choices) {
							choices = score.choices;
							if (!step.expect.unchanged) pendingObservedAt = Date.now();
							result.original_pending_response_at = new Date(
								pendingObservedAt,
							).toISOString();
						}
						if (step.context === "archive") {
							archivedTurns.push({ question: step.question, ...response.body });
							await reload();
						}
						if (!step.context && !step.library) {
							const body = response.body;
							turns.push({
								question: step.question,
								answer: body.answer,
								citations: body.citations,
								mode: body.mode ?? "live",
								refused: body.refused,
								refuse_reason: body.refuse_reason,
								retrieval_debug: body.retrieval_debug ?? null,
							});
						}
					} else if (step.op === "archive") {
						const selected = step.turns
							? step.turns.map((i) => turns[i])
							: turns;
						const body = await client.request("/api/rag/v1/threads", {
							method: "POST",
							body: {
								session_id: sessionId,
								library_id: libraries[scenario.library],
								title: `${runId} ${scenario.id}`,
								turns: selected,
							},
							expected: [200, 201],
						});
						threadId = id(body.id);
						archivedTurns = [...selected];
						report.owned_threads.push({
							id: threadId,
							library_id: libraries[scenario.library],
						});
						assertArchiveTurns(
							body,
							archivedTurns,
							libraries[scenario.library],
						);
						await reload();
						result.thread_id = threadId;
					} else if (step.op === "reload") await reload();
					else if (step.op === "wait") {
						assert.ok(pendingObservedAt);
						const target =
							pendingObservedAt +
							(step.phase === "midpoint" ? EXPIRY_MS / 2 : EXPIRY_MS + 1_000);
						result.started_at = new Date().toISOString();
						result.original_pending_response_at = new Date(
							pendingObservedAt,
						).toISOString();
						result.wait_until = new Date(target).toISOString();
						await save();
						console.log(
							`multi-turn ${scenario.id}: real TTL wait (${step.phase})`,
						);
						await sleep(Math.max(0, target - Date.now()), undefined, {
							signal,
						});
						result.elapsed_since_pending_ms = Date.now() - pendingObservedAt;
					} else {
						const source = sources[scenario.library][step.document];
						assert.ok(source);
						owned.assertOwned(source.library_id);
						if (step.op === "replace")
							await upload(scenario.library, step.replacement, source);
						else {
							const accepted = await client.request(
								`/api/libraries/${source.library_id}/documents/${id(source.document_id)}`,
								{ method: "DELETE", expected: [202] },
							);
							report.jobs.push({
								operation: "delete",
								library_id: source.library_id,
								accepted,
							});
							await save();
							const job = await waitForJob(
								client,
								id(accepted.job_id),
								300_000,
							);
							report.jobs.at(-1).terminal = job.status;
							assert.equal(job.status, "completed", "deletion must complete");
						}
						delete sources[scenario.library][step.document];
					}
					result.result = "PASS";
					await save();
				}
				row.result = "PASS";
			} catch (error) {
				row.result = "FAIL";
				row.error = error.message;
				if (row.steps.at(-1)) row.steps.at(-1).result = "FAIL";
				exitCode = 1;
			}
			await save();
			console.log(`multi-turn ${scenario.id}: ${row.result}`);
			if (signal?.aborted) break;
		}
		const finalHealth = await client.request("/api/rag/health/ready", {
			expected: [200, 503],
		});
		report.runtime_identity_after = finalHealth.release;
		validateIdentity(options, await localIdentity(), finalHealth);
		report.configuration_after = configurationFingerprint(finalHealth);
		assert.deepEqual(
			report.configuration_after,
			report.configuration,
			"model configuration changed during acceptance",
		);
		if (!options.development)
			assert.deepEqual(
				finalHealth.release,
				report.runtime_identity,
				"candidate changed during acceptance",
			);
	} catch (error) {
		exitCode = error.exitCode === EXIT_BLOCKED ? EXIT_BLOCKED : 1;
		report.error = error.message;
	} finally {
		cleaningUp = true;
		report.cleanup = await owned.cleanup(300_000, async (results) => {
			report.cleanup = results;
			await save();
		});
		if (report.cleanup.some((r) => r.result !== "PASS")) exitCode = 1;
		report.finished_at = new Date().toISOString();
		report.result =
			exitCode === EXIT_BLOCKED
				? "BLOCKED"
				: exitCode
					? "FAIL"
					: options.development
						? "DEVELOPMENT_PASS"
						: "PASS";
		report.release_gate = options.development
			? "not_evaluated"
			: exitCode === 0
				? "pass"
				: exitCode === EXIT_BLOCKED
					? "blocked"
					: "fail";
		await save();
	}
	console.log(`${report.result}: ${output}`);
	return { exitCode, report, output };
}

async function main() {
	const options = matrixOptions(process.argv.slice(2), process.env);
	if (options.plan) {
		console.log(
			JSON.stringify(planSummary(await loadMultiTurnPlan(), options), null, 2),
		);
		return 0;
	}
	const controller = new AbortController();
	const interrupt = () => controller.abort();
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", interrupt);
	try {
		return (
			await runMultiTurnMatrix(options, process.env[options.passwordEnv], {
				signal: controller.signal,
			})
		).exitCode;
	} finally {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", interrupt);
	}
}

if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			console.error(
				`${error.exitCode === EXIT_BLOCKED ? "BLOCKED" : "FAIL"}: ${redactText(error.message)}`,
			);
			process.exitCode = error.exitCode ?? 1;
		});
}
