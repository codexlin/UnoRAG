import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { cleanupIsolationTopology } from "../scripts/acceptance/isolation-cleanup.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = await readFile(
	path.join(root, "scripts/acceptance/s1_s2_isolation.sh"),
	"utf8",
);

function cleanupHarness({
	pending = 0,
	failed = 0,
	changed = false,
	apiFailure = false,
} = {}) {
	const events = [];
	const objects = new Set(["fixture-source"]);
	const points = new Set(["fixture-point"]);
	let deleted = false;
	let locked = false;
	const client = {
		async query(sql) {
			if (sql.startsWith("SELECT rag_library_id"))
				return {
					rows: [{ rag_library_id: "fixture-lib", workspace_id: "fixture-ws" }],
				};
			if (sql.includes("AS live_libraries")) {
				events.push("check");
				if (pending > 0) pending -= 1;
				return {
					rows: [
						{
							live_libraries: Number(!deleted || (changed && locked)),
							live_documents: Number(!deleted),
							pending_jobs: pending,
							failed_deletes: failed,
							pending_generations: 0,
						},
					],
				};
			}
			events.push(sql);
			if (sql.includes("FOR UPDATE")) locked = true;
			if (sql.startsWith("DELETE FROM")) {
				assert.equal(objects.size, 0, "SQL cannot orphan source objects");
				assert.equal(points.size, 0, "SQL cannot orphan vector points");
			}
			return { rows: [] };
		},
	};
	return {
		events,
		objects,
		points,
		options: {
			client,
			organizationIds: ["fixture-org"],
			owners: [
				{ email: "fixture-owner@example.test", workspace: "fixture-ws" },
			],
			password: "not-a-real-password",
			baseUrl: "http://fixture.invalid",
			timeoutMs: 100,
			pollMs: 0,
			createSession: () => ({
				async request(url, options) {
					events.push(`${options.method} ${url}`);
					if (options.method === "DELETE") {
						if (apiFailure) throw new Error("controlled API failure");
						objects.clear();
						points.clear();
						deleted = true;
					}
				},
			}),
		},
	};
}

test("cleanup removes product objects and points before cascading fixture topology", async () => {
	const fixture = cleanupHarness({ pending: 3 });
	const result = await cleanupIsolationTopology(fixture.options);
	assert.equal(result.status, "passed");
	assert.equal(fixture.objects.size, 0);
	assert.equal(fixture.points.size, 0);
	const apiDelete = fixture.events.indexOf("DELETE /api/libraries/fixture-lib");
	const cascade = fixture.events.findIndex((event) =>
		event.startsWith("DELETE FROM"),
	);
	assert.ok(apiDelete >= 0 && apiDelete < cascade);
	assert.ok(fixture.events.filter((event) => event === "check").length >= 3);
	assert.equal(fixture.events.at(-1), "COMMIT");
});

for (const [name, settings, expected] of [
	["API failure", { apiFailure: true }, /controlled API failure/],
	["failed delete job", { failed: 1 }, /deletion failed/],
	["cleanup timeout", { pending: 1_000_000 }, /timed out/],
	["late lifecycle write", { changed: true }, /lifecycle changed/],
]) {
	test(`cleanup retains topology on ${name}`, async () => {
		const fixture = cleanupHarness(settings);
		if (settings.pending) fixture.options.timeoutMs = 1;
		await assert.rejects(cleanupIsolationTopology(fixture.options), expected);
		assert.equal(
			fixture.events.some((event) => event.startsWith("DELETE FROM")),
			false,
		);
		if (settings.changed) assert.equal(fixture.events.at(-1), "ROLLBACK");
	});
}

test("cleanup is safe when bootstrap never committed or topology was already removed", async () => {
	const fixture = cleanupHarness();
	fixture.options.client.query = async (sql) => {
		fixture.events.push(sql);
		if (sql.startsWith("SELECT rag_library_id")) return { rows: [] };
		if (sql.includes("AS live_libraries"))
			return {
				rows: [
					{
						live_libraries: 0,
						live_documents: 0,
						pending_jobs: 0,
						failed_deletes: 0,
						pending_generations: 0,
					},
				],
			};
		return { rows: [] };
	};
	fixture.options.createSession = () => {
		throw new Error("must not log in without fixtures");
	};
	assert.equal(
		(await cleanupIsolationTopology(fixture.options)).libraries_requested,
		0,
	);
});

for (const scenario of [
	{
		name: "FAIL",
		bootstrap: 1,
		cleanup: 0,
		keep: "0",
		expectedCode: 1,
		expectedCleanup: "passed",
	},
	{
		name: "BLOCKED",
		bootstrap: 2,
		cleanup: 0,
		keep: "0",
		expectedCode: 2,
		expectedCleanup: "not_needed",
	},
	{
		name: "cleanup failure",
		bootstrap: 1,
		cleanup: 1,
		keep: "0",
		expectedCode: 1,
		expectedCleanup: "failed",
	},
	{
		name: "explicit keep",
		bootstrap: 1,
		cleanup: 0,
		keep: "1",
		expectedCode: 1,
		expectedCleanup: "kept",
	},
]) {
	test(`isolation exit trap reports ${scenario.name} honestly`, async () => {
		const directory = await mkdtemp(
			path.join(os.tmpdir(), "unorag-isolation-test-"),
		);
		try {
			const acceptance = path.join(directory, "scripts/acceptance");
			const bin = path.join(directory, "bin");
			await mkdir(acceptance, { recursive: true });
			await mkdir(bin);
			const target = path.join(acceptance, "s1_s2_isolation.sh");
			await writeFile(target, script);
			const marker = path.join(directory, "cleanup-called");
			const report = path.join(directory, "report.json");
			await writeFile(path.join(bin, "curl"), "#!/bin/sh\nprintf 200\n");
			await writeFile(
				path.join(bin, "node"),
				`#!/bin/sh\ncase "$*" in\n*--cleanup*) touch "$CLEANUP_MARKER"; exit ${scenario.cleanup};;\n*) exit ${scenario.bootstrap};;\nesac\n`,
			);
			await chmod(path.join(bin, "curl"), 0o755);
			await chmod(path.join(bin, "node"), 0o755);
			const run = spawnSync("bash", [target], {
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					UNORAG_ISOLATION_KEEP: scenario.keep,
					UNORAG_ISOLATION_REPORT: report,
					UNORAG_BASE_URL: "http://fixture.invalid",
					CLEANUP_MARKER: marker,
				},
				encoding: "utf8",
				timeout: 10_000,
			});
			assert.equal(run.status, scenario.expectedCode, run.stderr);
			const result = JSON.parse(await readFile(report, "utf8"));
			assert.equal(
				result.status,
				scenario.bootstrap === 2 ? "BLOCKED" : "FAIL",
			);
			assert.equal(result.cleanup, scenario.expectedCleanup);
			assert.doesNotMatch(run.stdout, /isolation PASS/);
			const called = await readFile(marker, "utf8").then(
				() => true,
				() => false,
			);
			assert.equal(
				called,
				["passed", "failed"].includes(scenario.expectedCleanup),
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}

// This deliberately fake product API exercises the unmodified shell, not product isolation.
async function serveShellProduct(t) {
	const libraries = new Map();
	const documents = new Map();
	const unexpected = [];
	const server = createServer(async (request, response) => {
		function send(status, body, headers = {}) {
			response.writeHead(status, {
				"content-type": "application/json",
				...headers,
			});
			response.end(JSON.stringify(body));
		}
		try {
			const url = new URL(request.url, "http://fixture.invalid");
			const parts = url.pathname.split("/").filter(Boolean);
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			const raw = Buffer.concat(chunks);
			const contentType = request.headers["content-type"] || "";
			const body = contentType.includes("application/json")
				? JSON.parse(raw.toString())
				: null;
			const actor =
				request.headers.authorization?.replace("Bearer fixture-", "") ||
				request.headers.cookie?.match(/actor=([^;]+)/)?.[1];
			const workspace = actor === "A1V" ? "A1" : actor;
			const visible = (libraryId) =>
				[...documents.values()].filter(
					(document) =>
						document.libraryId === libraryId &&
						!document.deleted &&
						!(actor === "A1V" && document.restricted),
				);
			if (url.pathname === "/api/rag/health") return send(200, { ready: true });
			if (url.pathname === "/api/auth/session" && request.method === "POST") {
				const label = body.email.includes("viewer") ? "A1V" : body.workspace_id;
				return send(200, {}, { "set-cookie": `actor=${label}; Path=/` });
			}
			if (url.pathname === "/api/workspace/keys" && request.method === "POST")
				return send(201, { key: `fixture-${workspace}` });
			if (url.pathname === "/api/libraries") {
				if (request.method === "POST") {
					const library = { id: `library-${workspace}`, workspace };
					libraries.set(library.id, library);
					return send(201, library);
				}
				return send(
					200,
					[...libraries.values()]
						.filter((library) => library.workspace === workspace)
						.map((library) => ({
							...library,
							doc_count: visible(library.id).length,
							ready_count: visible(library.id).length,
						})),
				);
			}
			if (
				[
					"/api/rag/v1/ask",
					"/api/rag/v1/retrieve",
					"/api/v1/ask",
					"/api/v1/retrieve",
				].includes(url.pathname)
			) {
				if (libraries.get(body.library_id)?.workspace !== workspace)
					return send(403, {});
				let selected = visible(body.library_id);
				if (body.query?.includes("designated review window"))
					selected = selected.filter((document) =>
						document.name.includes("Primary"),
					);
				if (body.query?.includes("approval retention period"))
					selected = selected.filter((document) =>
						document.name.includes("Restricted"),
					);
				const hits = selected.map((document) => ({
					doc_id: document.id,
					text: document.text,
				}));
				return send(200, {
					answer: selected.map((document) => document.text).join("\n"),
					hits,
					citations: hits,
				});
			}
			if (url.pathname === "/api/rag/v1/archive") return send(200, []);
			if (url.pathname.startsWith("/api/rag/v1/archive/")) return send(404, {});
			if (parts[1] === "jobs") {
				const hidden = [...documents.values()].some(
					(document) =>
						document.job_id === parts[2] &&
						actor === "A1V" &&
						document.restricted,
				);
				if (hidden) return send(404, {});
				return send(
					200,
					parts[2]
						? { status: "completed", stage: "done" }
						: visible(url.searchParams.get("library_id")).map((document) => ({
								id: document.job_id,
							})),
				);
			}
			if (url.pathname.startsWith("/api/rag/v1/documents/"))
				return send(404, {});
			if (parts[1] === "libraries" && parts[2]) {
				const library = libraries.get(parts[2]);
				if (library?.workspace !== workspace) return send(404, {});
				if (parts[3] === "documents") {
					if (!parts[4]) {
						if (request.method === "GET") return send(200, visible(library.id));
						const form = await new Request("http://fixture.invalid", {
							method: "POST",
							headers: { "content-type": contentType },
							body: raw,
						}).formData();
						const id = `document-${documents.size + 1}`;
						const document = {
							id,
							document_id: id,
							job_id: `ingest-${id}`,
							libraryId: library.id,
							name: form.get("display_name"),
							text: await form.get("file").text(),
							restricted: false,
							deleted: false,
						};
						documents.set(id, document);
						return send(202, document);
					}
					const document = documents.get(parts[4]);
					if (
						!document ||
						document.libraryId !== library.id ||
						(actor === "A1V" && document.restricted)
					)
						return send(404, {});
					if (parts[5] === "acl" && request.method === "PUT") {
						document.restricted = true;
						return send(200, {
							projection: "projection_queued",
							projection_job_id: "acl-job",
						});
					}
					if (parts[5] === "versions" && request.method === "POST")
						return send(202, { job_id: "replace-job" });
					if (!parts[5] && request.method === "DELETE") {
						document.deleted = true;
						return send(202, { job_id: "delete-job" });
					}
				}
			}
			unexpected.push(`${request.method} ${url.pathname}`);
			send(500, { detail: "unhandled fake API request" });
		} catch (error) {
			unexpected.push(String(error));
			send(500, { detail: "fake API failed" });
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(
		() =>
			new Promise((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	);
	return { baseUrl: `http://127.0.0.1:${server.address().port}`, unexpected };
}

async function shellFixture(
	t,
	{
		baseUrl,
		bootstrap = 0,
		cleanup = 0,
		pauseCleanup = false,
		reportSignalPhase = null,
	},
) {
	const directory = await mkdtemp(path.join(os.tmpdir(), "unorag-shell-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const acceptance = path.join(directory, "scripts/acceptance");
	const bin = path.join(directory, "bin");
	const temp = path.join(directory, "temp");
	await mkdir(acceptance, { recursive: true });
	await mkdir(bin);
	await mkdir(temp);
	const target = path.join(acceptance, "s1_s2_isolation.sh");
	const report = path.join(directory, "report.json");
	const marker = path.join(directory, "cleanup-started.json");
	const release = path.join(directory, "cleanup-release");
	const passReportMarker = path.join(directory, "pass-report-started.json");
	const passReportRelease = path.join(directory, "pass-report-release");
	const reportWrites = path.join(directory, "report-writes");
	const shim = path.join(directory, "bootstrap-shim.mjs");
	await writeFile(target, script);
	await writeFile(
		report,
		JSON.stringify({ status: "PASS", rc_sha: "previous-run" }),
	);
	await writeFile(
		path.join(bin, "node"),
		'#!/bin/sh\nexec "$FIXTURE_NODE" "$FIXTURE_BOOTSTRAP" "$@"\n',
	);
	await chmod(path.join(bin, "node"), 0o755);
	await writeFile(
		path.join(bin, "mktemp"),
		`#!/bin/sh
case "$*" in
  *unorag-iso-cookies*) directory="$FIXTURE_TEMP/cookies";;
  *unorag-iso-work*) directory="$FIXTURE_TEMP/work";;
  *) exit 1;;
esac
mkdir "$directory" || exit 1
printf '%s\\n' "$directory"
`,
	);
	await chmod(path.join(bin, "mktemp"), 0o755);
	let python;
	let bashEnv;
	if (reportSignalPhase) {
		const interpreter = spawnSync(
			"python3",
			["-c", "import sys; print(sys.executable)"],
			{ encoding: "utf8" },
		);
		assert.equal(interpreter.status, 0, interpreter.stderr);
		python = interpreter.stdout.trim();
		await writeFile(
			path.join(bin, "python3"),
			`#!/bin/sh
if [ "$1" = "-" ] && [ "$2" = "$UNORAG_ISOLATION_REPORT" ]; then
  printf '%s\\n' "$3" >> "$REPORT_WRITES"
  if [ "$3" = "PASS" ] && [ "$REPORT_SIGNAL_PHASE" != "captured" ] && [ ! -f "$PASS_REPORT_MARKER" ]; then
    if [ "$REPORT_SIGNAL_PHASE" = "after" ]; then
      "$FIXTURE_PYTHON" "$@"
      rc=$?
    fi
    printf '{"status":"PASS"}\\n' > "$PASS_REPORT_MARKER"
    while [ ! -f "$PASS_REPORT_RELEASE" ]; do sleep 0.01; done
    if [ "$REPORT_SIGNAL_PHASE" = "after" ]; then exit "$rc"; fi
  fi
fi
exec "$FIXTURE_PYTHON" "$@"
`,
		);
		await chmod(path.join(bin, "python3"), 0o755);
		if (reportSignalPhase === "captured") {
			// Bash 5 keeps BASH_COMMAND stale inside EXIT traps. Use the caller
			// and captured status to pause at the same boundary on Bash 3 and 5.
			bashEnv = path.join(directory, "before-python.bash");
			await writeFile(
				bashEnv,
				`fixture_before_python() {
  if [[ "\${FUNCNAME[1]:-}" == "write_report" && "\${status:-}" == "PASS" && ! -f "$PASS_REPORT_MARKER" ]]; then
    printf '{"status":"PASS"}\\n' > "$PASS_REPORT_MARKER"
    while [[ ! -f "$PASS_REPORT_RELEASE" ]]; do sleep 0.01; done
  fi
}
set -T
trap 'fixture_before_python' DEBUG
`,
			);
		}
	}
	await writeFile(
		shim,
		`
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
if (process.argv.includes("--cleanup")) {
  await writeFile(process.env.CLEANUP_MARKER, await readFile(process.env.UNORAG_ISOLATION_REPORT));
  if (${pauseCleanup}) while (!existsSync(process.env.CLEANUP_RELEASE)) await sleep(10);
  process.exit(${cleanup});
}
if (${bootstrap}) process.exit(${bootstrap});
await writeFile(process.argv[process.argv.indexOf("--out") + 1], JSON.stringify({
  workspaces: { A1: { id: "A1" }, A2: { id: "A2" }, B1: { id: "B1" } },
  users: [
    { id: "owner", email: "iso-a1-owner@unorag.isolation.test" },
    { id: "viewer", email: "iso-a1-viewer@unorag.isolation.test" }
  ]
}));
`,
	);
	const child = spawn("bash", [target], {
		detached: true,
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			TMPDIR: temp,
			FIXTURE_NODE: process.execPath,
			FIXTURE_BOOTSTRAP: shim,
			FIXTURE_TEMP: temp,
			FIXTURE_PYTHON: python,
			BASH_ENV: bashEnv,
			UNORAG_BASE_URL: baseUrl,
			UNORAG_ISOLATION_KEEP: "0",
			UNORAG_ISOLATION_REPORT: report,
			UNORAG_RC_SHA: "current-run",
			UNORAG_ISOLATION_TOPOLOGY: path.join(acceptance, "topology.json"),
			UNORAG_PILOT_JOB_TIMEOUT_SEC: "5",
			UNORAG_PILOT_POLL_INTERVAL_SEC: "0.01",
			CLEANUP_MARKER: marker,
			CLEANUP_RELEASE: release,
			PASS_REPORT_MARKER: passReportMarker,
			PASS_REPORT_RELEASE: passReportRelease,
			REPORT_WRITES: reportWrites,
			REPORT_SIGNAL_PHASE: reportSignalPhase,
		},
	});
	let stdout = "";
	let stderr = "";
	let exited = false;
	child.stdout.on("data", (data) => {
		stdout += data;
	});
	child.stderr.on("data", (data) => {
		stderr += data;
	});
	const kill = () => {
		if (exited) return;
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch (error) {
			if (error.code !== "ESRCH") throw error;
		}
	};
	const timer = setTimeout(kill, 45_000);
	const done = once(child, "close").then(([code, signal]) => {
		exited = true;
		clearTimeout(timer);
		return { code, signal, stdout, stderr };
	});
	t.after(async () => {
		kill();
		await done;
	});
	return {
		child,
		done,
		report,
		marker,
		release,
		temp,
		passReportMarker,
		passReportRelease,
		reportWrites,
	};
}

async function waitForJsonMarker(marker, status) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			const value = JSON.parse(await readFile(marker, "utf8"));
			if (status === undefined || value.status === status) return value;
		} catch (error) {
			if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
				throw error;
		}
		await sleep(10);
	}
	assert.fail(`timed out waiting for fixture marker ${path.basename(marker)}`);
}

test("SIGTERM during cleanup writes FAIL with exit 143 and removes temporary credentials", {
	timeout: 60_000,
}, async (t) => {
	const api = await serveShellProduct(t);
	const fixture = await shellFixture(t, {
		baseUrl: api.baseUrl,
		bootstrap: 1,
		pauseCleanup: true,
	});
	const running = await waitForJsonMarker(fixture.marker);
	assert.equal(running.status, "RUNNING");
	assert.equal(running.rc_sha, "current-run");
	assert.equal(running.finished_at, null);
	assert.equal((await readdir(fixture.temp)).length, 2);
	await writeFile(
		path.join(fixture.temp, "cookies/session.jar"),
		"fixture cookie",
	);
	await writeFile(
		path.join(fixture.temp, "work/key.json"),
		"fixture service key",
	);
	assert.equal(fixture.child.kill("SIGTERM"), true);
	await writeFile(fixture.release, "release cleanup");
	const run = await fixture.done;
	assert.equal(run.signal, null, run.stderr);
	assert.equal(run.code, 143, run.stderr);
	const result = JSON.parse(await readFile(fixture.report, "utf8"));
	assert.equal(result.status, "FAIL");
	assert.equal(result.rc_sha, "current-run");
	assert.match(result.detail, /terminat/i);
	assert.ok(result.finished_at);
	assert.doesNotMatch(run.stdout, /isolation PASS/);
	assert.deepEqual(await readdir(fixture.temp), []);
	assert.deepEqual(api.unexpected, []);
});

for (const [phase, description] of [
	["captured", "after shell captures PASS but before invoking Python"],
	["before", "before Python executes the captured PASS writer"],
	["after", "after Python writes PASS but before returning to the shell"],
]) {
	test(`SIGTERM ${description} leaves FAIL, exits 143, and clears temporary credentials`, {
		timeout: 60_000,
	}, async (t) => {
		const api = await serveShellProduct(t);
		const fixture = await shellFixture(t, {
			baseUrl: api.baseUrl,
			reportSignalPhase: phase,
		});
		const marker = await Promise.race([
			waitForJsonMarker(fixture.passReportMarker),
			fixture.done.then((run) =>
				assert.fail(
					`shell exited before report boundary: ${JSON.stringify(run)}`,
				),
			),
		]);
		assert.deepEqual(marker, {
			status: "PASS",
		});
		const beforeSignal = JSON.parse(await readFile(fixture.report, "utf8"));
		assert.equal(beforeSignal.status, phase === "after" ? "PASS" : "RUNNING");
		assert.equal(beforeSignal.rc_sha, "current-run");
		if (phase !== "after") assert.equal(beforeSignal.finished_at, null);
		assert.deepEqual((await readdir(fixture.temp)).sort(), ["cookies", "work"]);
		assert.equal(fixture.child.kill("SIGTERM"), true);
		if (phase === "captured") {
			// Let the trap publish FAIL before the original local PASS writer resumes.
			const interrupted = await waitForJsonMarker(fixture.report, "FAIL");
			assert.equal(interrupted.cleanup, "passed");
		}
		await writeFile(fixture.passReportRelease, "release PASS writer");
		const run = await fixture.done;
		assert.deepEqual(api.unexpected, []);
		assert.equal(run.signal, null, run.stderr);
		assert.equal(run.code, 143, `${run.stdout}\n${run.stderr}`);
		const result = JSON.parse(await readFile(fixture.report, "utf8"));
		assert.equal(result.status, "FAIL");
		assert.equal(result.cleanup, "passed");
		assert.equal(result.rc_sha, "current-run");
		assert.match(result.detail, /terminat|interrupt/i);
		assert.ok(result.finished_at);
		assert.equal(result.checks.length, 29);
		assert.ok(result.checks.every((check) => check.status === "pass"));
		const writes = (await readFile(fixture.reportWrites, "utf8"))
			.trim()
			.split("\n");
		assert.equal(writes[0], "RUNNING");
		const capturedPass = writes.indexOf("PASS");
		assert.ok(capturedPass > 0, "the captured PASS writer must execute");
		if (phase === "captured") {
			assert.ok(
				writes.slice(1, capturedPass).includes("FAIL"),
				"the signal handler must publish FAIL before the stale PASS resumes",
			);
		}
		assert.equal(writes.at(-1), "FAIL");
		assert.ok(
			writes.slice(capturedPass + 1).every((status) => status === "FAIL"),
			"every write after the stale PASS must preserve failure",
		);
		assert.doesNotMatch(run.stdout, /isolation PASS/);
		assert.match(run.stdout, /isolation finished/);
		assert.deepEqual(await readdir(fixture.temp), []);
	});
}

for (const cleanup of [0, 1]) {
	test(`all 29 shell probes complete before cleanup ${cleanup === 0 ? "success" : "failure"} determines the final result`, {
		timeout: 60_000,
	}, async (t) => {
		const api = await serveShellProduct(t);
		const fixture = await shellFixture(t, { baseUrl: api.baseUrl, cleanup });
		const run = await fixture.done;
		assert.deepEqual(api.unexpected, []);
		assert.equal(run.signal, null, run.stderr);
		assert.equal(run.code, cleanup, `${run.stdout}\n${run.stderr}`);
		const beforeCleanup = JSON.parse(await readFile(fixture.marker, "utf8"));
		assert.equal(beforeCleanup.status, "RUNNING");
		assert.equal(beforeCleanup.finished_at, null);
		const result = JSON.parse(await readFile(fixture.report, "utf8"));
		assert.equal(result.status, cleanup === 0 ? "PASS" : "FAIL");
		assert.equal(result.cleanup, cleanup === 0 ? "passed" : "failed");
		assert.equal(result.rc_sha, "current-run");
		assert.ok(result.finished_at);
		assert.equal(result.checks.length, 29);
		assert.equal(new Set(result.checks.map((check) => check.id)).size, 29);
		assert.ok(result.checks.every((check) => check.status === "pass"));
		assert.match(run.stdout, /isolation finished/);
		assert.doesNotMatch(run.stdout, /isolation PASS/);
		if (cleanup !== 0) assert.match(result.detail, /cleanup failed/);
		assert.deepEqual(await readdir(fixture.temp), []);
	});
}

test("isolation acceptance can bootstrap through the pinned Ops image", () => {
	assert.match(script, /run_topology\(\)/);
	assert.match(script, /host_uid="\$\(id -u\)"/);
	assert.match(script, /host_gid="\$\(id -g\)"/);
	assert.match(
		script,
		/mk_compose --profile ops run --rm --user "\$host_uid:\$host_gid"/,
	);
	assert.doesNotMatch(script, /mk_compose --profile ops run --rm --user 0/);
	assert.match(script, /--entrypoint node inspect-lifecycle/);
	assert.match(script, /run_topology bootstrap/);
	assert.match(script, /run_topology cleanup/);
});

test("isolation acceptance covers ACL-protected metadata surfaces", () => {
	for (const check of [
		"S3.metadata_document_list",
		"S3.metadata_owner_inventory",
		"S3.metadata_library_counts",
		"S3.metadata_job_list",
	]) {
		assert.match(script, new RegExp(check.replaceAll(".", "\\.")));
	}
	for (const probe of ["versions:", "acl:", "job:", "download:"]) {
		assert.match(script, new RegExp(`"${probe}`));
	}
	assert.match(script, /record "S3\.metadata_\$\{probe_name\}"/);
	assert.match(script, /expected 404/);
});
