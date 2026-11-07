import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	loadGoldenJsonl,
	loadNegativeGoldenJsonl,
	parseGoldenCase,
	parseNegativeGoldenJsonl,
} from "../../src/evaluation/golden-set.ts";
import {
	scoreNegativeCase,
	scorePositiveCase,
	summarizeEvaluation,
} from "../../src/evaluation/scoring.ts";
import {
	deleteLibraryAndWait,
	ProductSession,
	waitForJob,
} from "./recovery-probe.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST = resolve(ROOT, "testdata/business/scenarios.json");
const TERMINAL = new Set(["completed", "failed", "dead", "cancelled"]);
const hash = (data) => createHash("sha256").update(data).digest("hex");

export async function loadBusinessPlan(manifestPath = MANIFEST) {
	const specification = JSON.parse(await readFile(manifestPath, "utf8"));
	assert.equal(specification.schema_version, 1);
	const contractVersion = specification.contract_version ?? 1;
	assert.ok(
		[1, 2, 3].includes(contractVersion),
		"unsupported contract version",
	);
	assert.ok(
		Array.isArray(specification.documents) &&
			specification.documents.length > 0,
	);
	const fixtureRoot = await realpath(resolve(ROOT, "testdata"));
	const documents = [];
	for (const document of specification.documents) {
		let bytes, filename, origin;
		if (document.path) {
			assert.equal(
				document.content,
				undefined,
				"fixture cannot have two sources",
			);
			const path = await realpath(resolve(ROOT, document.path));
			assert.ok(
				path.startsWith(fixtureRoot + sep),
				"source must stay inside testdata",
			);
			bytes = await readFile(path);
			filename = basename(path);
			origin = "repository-fixture";
		} else {
			assert.equal(document.origin, "synthetic");
			assert.equal(typeof document.content, "string");
			assert.equal(basename(document.filename), document.filename);
			assert.ok(!/[\\/:\p{Cc}]/u.test(document.filename));
			bytes = Buffer.from(document.content);
			filename = document.filename;
			origin = document.origin;
		}
		assert.ok(
			/\.(md|txt|pdf|docx)$/u.test(filename),
			"unsupported positive fixture",
		);
		assert.ok(bytes.length > 0 && bytes.length <= 50 * 1024 * 1024);
		assert.ok(
			!documents.some((item) => item.filename === filename),
			"duplicate fixture filename",
		);
		documents.push({ filename, origin, bytes, sha256: hash(bytes) });
	}
	const positive = [
		...(await loadGoldenJsonl(resolve(ROOT, "testdata/ab/golds.jsonl"))),
		...specification.positive.map(parseGoldenCase),
	];
	const negative = [
		...(await loadNegativeGoldenJsonl(
			resolve(ROOT, "testdata/ab/negative-golds.jsonl"),
		)),
		...parseNegativeGoldenJsonl(
			specification.negative.map((item) => JSON.stringify(item)).join("\n"),
		),
	];
	assert.equal(
		new Set(positive.map((item) => item.id)).size,
		positive.length,
		"duplicate positive id",
	);
	assert.equal(
		new Set(negative.map((item) => item.id)).size,
		negative.length,
		"duplicate negative id",
	);
	const names = new Set(documents.map((item) => item.filename));
	const used = new Set();
	for (const gold of positive)
		for (const source of [gold, ...(gold.supporting_sources ?? [])]) {
			assert.ok(names.has(source.file), `missing fixture ${source.file}`);
			used.add(source.file);
		}
	assert.equal(
		used.size,
		documents.length,
		"every positive fixture needs an oracle",
	);
	return {
		contractVersion,
		documents,
		positive,
		negative,
		sha256:
			contractVersion >= 3
				? hash(
						JSON.stringify({
							specification,
							positive,
							negative,
							documents: documents.map(({ filename, sha256 }) => ({
								filename,
								sha256,
							})),
						}),
					)
				: hash(await readFile(manifestPath)),
	};
}

export function safePlanSummary(plan) {
	/** @type {Record<string, number>} */
	const origins = {};
	for (const document of plan.documents) {
		origins[document.origin] = (origins[document.origin] ?? 0) + 1;
	}
	return {
		contract_version: plan.contractVersion,
		files: plan.documents.length,
		positive: plan.positive.length,
		negative: plan.negative.length,
		manifest_sha256: plan.sha256,
		files_by_origin: origins,
	};
}

function evaluationResponse(result, elapsed) {
	const body = result.body ?? {};
	return {
		httpStatus: result.status,
		answer: body.answer ?? "",
		refused: body.refused === true,
		refuseReason: body.refuse_reason,
		latencyMs: Math.round(elapsed),
		requestId: result.headers.get("x-request-id") ?? body.trace_id ?? null,
		sessionId: body.session_id,
		retrievalDebug: body.retrieval_debug,
		citations: (body.citations ?? []).map((citation) => ({
			...citation,
			text: citation.body ?? citation.text ?? citation.snippet ?? "",
		})),
	};
}

export async function runBusinessMatrix(options) {
	assert.equal(
		options.accept,
		"YES",
		"explicit business acceptance opt-in required",
	);
	const target = new URL(options.baseUrl);
	assert.ok(
		target.protocol === "https:" ||
			(target.protocol === "http:" &&
				["localhost", "127.0.0.1"].includes(target.hostname)),
	);
	assert.ok(
		!target.username &&
			!target.password &&
			target.pathname === "/" &&
			!target.search &&
			!target.hash,
	);
	assert.match(options.expectedRevision, /^[a-f0-9]{40}$/u);
	const plan = await loadBusinessPlan(options.manifestPath);
	const runId = `business-${new Date().toISOString().replace(/[-:.]/gu, "")}-${randomUUID().slice(0, 8)}`;
	const output = resolve(
		options.outputDirectory ?? resolve(ROOT, ".unorag/acceptance", runId),
	);
	assert.ok(
		output.startsWith(resolve(ROOT, ".unorag") + sep),
		"private outputs must stay in .unorag",
	);
	await mkdir(output, { recursive: true, mode: 0o700 });
	const report = {
		run_id: runId,
		started_at: new Date().toISOString(),
		result: "RUNNING",
		target: target.origin,
		plan: safePlanSummary(plan),
		release: null,
		owned_libraries: [],
		jobs: [],
		downloads: [],
		positive: [],
		negative: [],
		workflows: [],
		diagnostics: [],
		cleanup: [],
	};
	const save = () =>
		writeFile(
			resolve(output, "report.json"),
			`${JSON.stringify(report, null, 2)}\n`,
			{ mode: 0o600 },
		);
	const client = new ProductSession(target.origin);
	const health = await client.request("/api/rag/health/ready");
	assert.equal(health.release.revision, options.expectedRevision);
	assert.ok(health.live_ready && health.ask_ready);
	report.release = health.release;
	const login = await client.login(options.email, options.password);
	assert.ok(
		!login.mustChangePassword,
		"change bootstrap password before acceptance",
	);
	async function createLibrary(label, keep = false) {
		const name = `${runId} ${label}`,
			library = await client.request("/api/libraries", {
				method: "POST",
				body: { name },
				expected: [200, 201],
			});
		report.owned_libraries.push({ id: library.id, name, keep });
		await save();
		return library.id;
	}
	async function upload(libraryId, filename, bytes, documentId) {
		const form = new FormData();
		form.set("file", new Blob([bytes]), filename);
		return client.request(
			`/api/libraries/${libraryId}/documents${documentId ? `/${documentId}/versions` : ""}`,
			{ method: "POST", body: form, expected: [202] },
		);
	}
	async function ask(
		libraryId,
		question,
		sessionId = `${runId}-${randomUUID()}`,
	) {
		const start = performance.now();
		try {
			const result = await client.requestDetailed("/api/rag/v1/ask", {
				method: "POST",
				body: { library_id: libraryId, question, session_id: sessionId },
				expected: [200, 400, 401, 403, 404, 409, 429, 500, 502, 503, 504],
				timeoutMs: 120000,
			});
			return evaluationResponse(result, performance.now() - start);
		} catch (error) {
			return {
				httpStatus: 0,
				answer: "",
				refused: false,
				citations: [],
				latencyMs: Math.round(performance.now() - start),
				requestId: null,
				transportError: error.message,
			};
		}
	}
	async function check(name, operation) {
		const start = performance.now();
		try {
			const detail = await operation();
			report.workflows.push({
				name,
				result: "PASS",
				duration_ms: Math.round(performance.now() - start),
				detail,
			});
		} catch (error) {
			report.workflows.push({
				name,
				result: "FAIL",
				duration_ms: Math.round(performance.now() - start),
				error: error.message,
			});
		}
		await save();
		console.log(`workflow ${name}: ${report.workflows.at(-1).result}`);
	}
	try {
		const libraryId = await createLibrary(
			"mixed-corpus",
			!!options.keepLibrary,
		);
		report.library_id = libraryId;
		for (const document of plan.documents) {
			const started = performance.now();
			try {
				const accepted = await upload(
					libraryId,
					document.filename,
					document.bytes,
				);
				report.jobs.push({
					filename: document.filename,
					origin: document.origin,
					sha256: document.sha256,
					...accepted,
				});
				await save();
				const job = await waitForJob(client, accepted.job_id, 900000),
					row = report.jobs.at(-1);
				Object.assign(row, {
					status: job.status,
					stage: job.stage,
					error: job.error,
					parser_report: job.parser_report,
					stage_runs: job.stage_runs,
					duration_ms: Math.round(performance.now() - started),
				});
				if (job.status === "completed") {
					const versions = await client.request(
						`/api/libraries/${libraryId}/documents/${accepted.document_id}/versions`,
					);
					row.active_version_id = versions.active_version_id;
					const response = await fetch(
						`${target.origin}/api/rag/v1/documents/${accepted.document_id}/download`,
						{
							headers: { cookie: client.cookie },
							signal: AbortSignal.timeout(60000),
						},
					);
					const actualHash =
						response.status === 200
							? hash(Buffer.from(await response.arrayBuffer()))
							: null;
					report.downloads.push({
						filename: document.filename,
						status: response.status,
						sha256_match: actualHash === document.sha256,
					});
				}
			} catch (error) {
				report.jobs.push({
					filename: document.filename,
					status: "acceptance_error",
					error: error.message,
				});
			}
			console.log(`ingest ${document.filename}: ${report.jobs.at(-1).status}`);
			await save();
		}
		for (const gold of plan.positive) {
			const job = report.jobs.find((item) => item.filename === gold.file);
			const response =
				job?.status === "completed"
					? await ask(libraryId, gold.question)
					: {
							httpStatus: 0,
							answer: "",
							refused: false,
							citations: [],
							latencyMs: 0,
							requestId: null,
						};
			const score = scorePositiveCase(gold, response);
			report.positive.push({ gold, response, score });
			await save();
			console.log(
				`positive ${report.positive.length}/${plan.positive.length} ${gold.id}: ${score.ok ? "PASS" : "FAIL"}`,
			);
		}
		for (const gold of plan.negative) {
			const response = await ask(libraryId, gold.question),
				score = scoreNegativeCase(response);
			report.negative.push({ gold, response, score });
			await save();
			console.log(
				`negative ${report.negative.length}/${plan.negative.length} ${gold.id}: ${score.ok ? "PASS" : "FAIL"}`,
			);
		}
		const lifecycleId = await createLibrary("publication"),
			file = "publication-policy.md";
		const contents = (value) =>
			Buffer.from(
				`# 发布额度管理\n\n本库当前生效的采购审批上限为${value}元人民币。此为独立验收制度，不引用其他库。\n`,
			);
		let documentId, activeId;
		async function verifyValue(value) {
			const response = await ask(
				lifecycleId,
				"本库当前生效的采购审批上限是多少元？",
			);
			const score = scorePositiveCase(
				parseGoldenCase({
					file,
					mode: "publication",
					question: "当前审批上限",
					answer: `${value}元`,
					key_facts: [String(value)],
				}),
				response,
			);
			assert.ok(
				score.ok,
				`active value ${value} not supported: request=${response.requestId}`,
			);
			return response.requestId;
		}
		await check("initial_publication", async () => {
			const accepted = await upload(lifecycleId, file, contents(13579));
			documentId = accepted.document_id;
			assert.equal(
				(await waitForJob(client, accepted.job_id)).status,
				"completed",
			);
			const versions = await client.request(
				`/api/libraries/${lifecycleId}/documents/${documentId}/versions`,
			);
			activeId = versions.active_version_id;
			assert.ok(activeId);
			return {
				request_id: await verifyValue(13579),
				active_version_id: activeId,
			};
		});
		if (documentId && activeId) {
			await check("replace_and_activate", async () => {
				const accepted = await upload(
					lifecycleId,
					file,
					contents(24680),
					documentId,
				);
				assert.equal(
					(await waitForJob(client, accepted.job_id)).status,
					"completed",
				);
				const versions = await client.request(
					`/api/libraries/${lifecycleId}/documents/${documentId}/versions`,
				);
				assert.equal(versions.active_version_id, accepted.document_version_id);
				assert.notEqual(versions.active_version_id, activeId);
				activeId = versions.active_version_id;
				return {
					request_id: await verifyValue(24680),
					active_version_id: activeId,
				};
			});
			await check("failed_replace_keeps_active", async () => {
				const accepted = await upload(
					lifecycleId,
					"broken-replacement.pdf",
					Buffer.from("%PDF-1.7\ncontrolled invalid PDF\n%%EOF"),
					documentId,
				);
				const job = await waitForJob(client, accepted.job_id, 900000);
				assert.ok(["failed", "dead"].includes(job.status));
				const versions = await client.request(
					`/api/libraries/${lifecycleId}/documents/${documentId}/versions`,
				);
				assert.equal(versions.active_version_id, activeId);
				return { job_status: job.status, request_id: await verifyValue(24680) };
			});
			await check("latest_accepted_replace_wins", async () => {
				const earlier = await upload(
						lifecycleId,
						file,
						contents(35791),
						documentId,
					),
					later = await upload(lifecycleId, file, contents(46802), documentId);
				const firstJob = await waitForJob(client, earlier.job_id, 900000),
					lastJob = await waitForJob(client, later.job_id, 900000);
				assert.ok(TERMINAL.has(firstJob.status));
				assert.equal(lastJob.status, "completed");
				const versions = await client.request(
					`/api/libraries/${lifecycleId}/documents/${documentId}/versions`,
				);
				assert.equal(versions.active_version_id, later.document_version_id);
				assert.equal(versions.desired_version_id, later.document_version_id);
				activeId = versions.active_version_id;
				return {
					earlier_status: firstJob.status,
					request_id: await verifyValue(46802),
				};
			});
			await check("reindex_preserves_current_content", async () => {
				const accepted = await client.request(
					`/api/libraries/${lifecycleId}/documents/${documentId}/reindex`,
					{ method: "POST", expected: [202] },
				);
				assert.equal(
					(await waitForJob(client, accepted.job_id, 900000)).status,
					"completed",
				);
				return { request_id: await verifyValue(46802) };
			});
			await check("cross_library_refusal", async () => {
				const response = await ask(
					lifecycleId,
					"Aster Edge AE-210 的 HTTPS 管理端口是多少？",
				);
				assert.ok(scoreNegativeCase(response).ok);
				return { request_id: response.requestId };
			});
			await check("delete_revokes_retrieval_and_download", async () => {
				const accepted = await client.request(
					`/api/libraries/${lifecycleId}/documents/${documentId}`,
					{ method: "DELETE", expected: [202] },
				);
				assert.equal(
					(await waitForJob(client, accepted.job_id)).status,
					"completed",
				);
				const response = await ask(
					lifecycleId,
					"本库当前生效的采购审批上限是多少元？",
				);
				assert.ok(scoreNegativeCase(response).ok);
				assert.equal(response.citations.length, 0);
				assert.equal(
					(
						await fetch(
							`${target.origin}/api/rag/v1/documents/${documentId}/download`,
							{ headers: { cookie: client.cookie } },
						)
					).status,
					404,
				);
				return { request_id: response.requestId };
			});
		}
		await check("unsupported_uploads_rejected", async () => {
			const statuses = [];
			for (const name of ["sample.html", "notes.csv"]) {
				const form = new FormData();
				form.set("file", new Blob(["controlled unsupported fixture"]), name);
				const result = await client.requestDetailed(
					`/api/libraries/${libraryId}/documents`,
					{ method: "POST", body: form, expected: [400, 415] },
				);
				statuses.push({ name, status: result.status });
			}
			return statuses;
		});
		const selected = [
			...report.positive.filter((row) => !row.score.ok),
			...report.positive.filter((row) => row.score.ok).slice(0, 3),
			...report.negative.filter((row) => !row.score.ok),
		]
			.filter((row) => row.response.requestId)
			.slice(0, 20);
		for (const row of selected) {
			try {
				const list = await client.request(
						`/api/workspace/operations/requests?range=24h&request_id=${row.response.requestId}`,
					),
					found = list.items.find(
						(item) => item.request_id === row.response.requestId,
					);
				assert.ok(found);
				const detail = await client.request(
					`/api/workspace/operations/events/ask/${found.id}`,
				);
				assert.ok(Array.isArray(detail.stages) && detail.stages.length > 0);
				report.diagnostics.push({
					case_id: row.gold.id,
					request_id: row.response.requestId,
					result: "PASS",
					detail,
				});
			} catch (error) {
				report.diagnostics.push({
					case_id: row.gold.id,
					request_id: row.response.requestId,
					result: "FAIL",
					error: error.message,
				});
			}
			await save();
		}
		report.summary = summarizeEvaluation(
			report.positive.map((row) => row.score),
			report.negative.map((row) => row.score),
		);
		report.gates = {
			latency_p95_limit_ms: 15000,
			latency_ok:
				report.summary.latencyP95Ms != null &&
				report.summary.latencyP95Ms <= 15000,
		};
		report.result =
			report.jobs.length === plan.documents.length &&
			report.jobs.every(
				(row) => row.status === "completed" && row.active_version_id,
			) &&
			report.downloads.length === plan.documents.length &&
			report.downloads.every((row) => row.sha256_match) &&
			report.positive.every((row) => row.score.ok) &&
			report.negative.every((row) => row.score.ok) &&
			report.workflows.length === 8 &&
			report.workflows.every((row) => row.result === "PASS") &&
			report.diagnostics.length > 0 &&
			report.diagnostics.every((row) => row.result === "PASS") &&
			report.gates.latency_ok
				? "PASS"
				: "FAIL";
	} catch (error) {
		report.result = "FAIL";
		report.error = error.message;
	} finally {
		for (const library of report.owned_libraries) {
			if (library.keep) {
				report.cleanup.push({
					library_id: library.id,
					result: "KEPT_FOR_BROWSER",
				});
				continue;
			}
			try {
				await deleteLibraryAndWait(client, library.id, 300000);
				report.cleanup.push({ library_id: library.id, result: "PASS" });
			} catch (error) {
				report.result = "FAIL";
				report.cleanup.push({
					library_id: library.id,
					result: "FAIL",
					error: error.message,
				});
			}
		}
		report.finished_at = new Date().toISOString();
		await save();
	}
	console.log(
		JSON.stringify({
			run_id: runId,
			result: report.result,
			report: resolve(output, "report.json"),
			summary: report.summary,
		}),
	);
	return report;
}

async function main() {
	const args = process.argv.slice(2);
	assert.ok(
		args.every((arg) => ["--plan", "--keep-library"].includes(arg)),
		"unknown argument",
	);
	if (args.includes("--plan")) {
		console.log(
			JSON.stringify(safePlanSummary(await loadBusinessPlan()), null, 2),
		);
		return;
	}
	const report = await runBusinessMatrix({
		accept: process.env.UNORAG_ACCEPT_BUSINESS_MATRIX,
		baseUrl: process.env.UNORAG_BASE_URL,
		expectedRevision: process.env.UNORAG_EXPECT_REVISION,
		email: process.env.UNORAG_ADMIN_EMAIL,
		password: process.env.UNORAG_ADMIN_PASSWORD,
		keepLibrary: args.includes("--keep-library"),
	});
	process.exitCode = report.result === "PASS" ? 0 : 1;
}
if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) === resolve(process.argv[1])
)
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
