import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	readReleaseManifest,
	redactValue,
	runCommand,
	writeEvidence,
} from "../scripts/acceptance/lib/runtime.mjs";
import { deleteLibraryAndWait } from "../scripts/acceptance/recovery-probe.mjs";
import { validateProfile } from "../scripts/acceptance/release-gate.mjs";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);

function manifest(revision, image = "ghcr.io/unorag/web:local") {
	return [
		`UNORAG_WEB_IMAGE=${image}`,
		`UNORAG_WEB_MIGRATOR_IMAGE=${image}`,
		`UNORAG_WEB_OPS_IMAGE=${image}`,
		`UNORAG_DBOS_WORKER_IMAGE=${image}`,
		"UNORAG_VERSION=0.2.3",
		`UNORAG_REVISION=${revision}`,
		`UNORAG_DBOS_APPLICATION_VERSION=unorag-${revision}`,
		"",
	].join("\n");
}

test("release evidence recursively redacts credentials", () => {
	const redacted = redactValue({
		stage: { detail: "Authorization: Bearer live-token" },
		password: "VerySecret123",
		api_key: "sk-live-secret",
		password_env: "UNORAG_ADMIN_PASSWORD",
	});
	const serialized = JSON.stringify(redacted);
	assert.doesNotMatch(serialized, /live-token|VerySecret123|sk-live-secret/);
	assert.match(serialized, /redacted/);
	assert.match(serialized, /UNORAG_ADMIN_PASSWORD/);
});

test("release evidence renders structured stage details as readable JSON", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "unorag-release-evidence-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const jsonPath = join(directory, "report.json");
	const markdownPath = join(directory, "report.md");
	await writeEvidence({
		jsonPath,
		markdownPath,
		report: {
			name: "Evidence test",
			result: "PASS",
			stages: [
				{
					name: "seed",
					status: "PASS",
					detail: { active_version_id: "v1", note: "left | right" },
				},
			],
		},
	});
	const markdown = await readFile(markdownPath, "utf8");
	assert.doesNotMatch(markdown, /\[object Object\]/);
	assert.match(
		markdown,
		/\{"active_version_id":"v1","note":"left \\\| right"\}/,
	);
});

test("acceptance command logs redact bare secret environment values", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "unorag-command-log-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const logPath = join(directory, "command.log");
	const secret = "BareSecretValue123";
	const result = await runCommand({
		command: process.execPath,
		args: ["-e", "process.stdout.write(process.env.TEST_PASSWORD)"],
		env: { TEST_PASSWORD: secret },
		logPath,
		stream: false,
	});
	assert.equal(result.code, 0);
	assert.doesNotMatch(result.stdout, new RegExp(secret));
	assert.equal(await readFile(logPath, "utf8"), "<redacted>");
});

test("executable release manifests require four immutable digests", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "unorag-release-manifest-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "release.env");
	await writeFile(path, manifest("a".repeat(40)));
	await assert.rejects(
		() => readReleaseManifest(path),
		/immutable sha256 digest/,
	);
	await assert.doesNotReject(() =>
		readReleaseManifest(path, { allowLocalImages: true }),
	);
	const digest = `ghcr.io/unorag/web@sha256:${"b".repeat(64)}`;
	await writeFile(path, manifest("a".repeat(40), digest));
	await assert.doesNotReject(() => readReleaseManifest(path));
});

test("release profile is strict and never contains a password", () => {
	const valid = {
		schema_version: 1,
		release_id: "v0.2.3-rc.1",
		expected_git_revision: "a".repeat(40),
		base_url: "https://candidate.example.com/",
		admin_email: "admin@example.com",
		password_env: "UNORAG_ADMIN_PASSWORD",
		previous_manifest: "previous.env",
		candidate_manifest: "candidate.env",
		allow_platform_emulation: true,
		gates: {
			code: true,
			browser: true,
			runtime: true,
			upgrade_rollback: true,
			provider_faults: true,
			restore: true,
		},
	};
	assert.equal(
		validateProfile(valid).base_url,
		"https://candidate.example.com",
	);
	assert.equal(validateProfile(valid).allow_platform_emulation, true);
	assert.equal(
		validateProfile({ ...valid, allow_platform_emulation: undefined })
			.allow_platform_emulation,
		false,
	);
	assert.throws(
		() => validateProfile({ ...valid, allow_platform_emulation: "yes" }),
		/allow_platform_emulation must be boolean/,
	);
	assert.throws(
		() => validateProfile({ ...valid, password: "should-not-be-here" }),
		/unknown release gate profile field: password/,
	);
	assert.throws(
		() => validateProfile({ ...valid, expected_git_revision: "main" }),
		/full lowercase Git SHA/,
	);
});

test("release code gate fails closed unless pnpm executes with Node 22", async () => {
	const source = await readFile(
		new URL("scripts/acceptance/release-gate.mjs", root),
		"utf8",
	);
	assert.match(source, /"node_runtime"/);
	assert.match(
		source,
		/Number\(process\.versions\.node\.split\('\.'\)\[0\]\) !== 22/,
	);
});

test("probe cleanup waits for asynchronous library deletion", async () => {
	let reads = 0;
	const requests = [];
	const session = {
		async request(path, options) {
			requests.push({ path, method: options?.method || "GET" });
			if (options?.method === "DELETE") return { status: "deleting" };
			reads += 1;
			return reads < 2 ? [{ id: "library-probe", status: "deleting" }] : [];
		},
	};
	await deleteLibraryAndWait(session, "library-probe", 2_500);
	assert.deepEqual(requests, [
		{ path: "/api/libraries/library-probe", method: "DELETE" },
		{ path: "/api/libraries", method: "GET" },
		{ path: "/api/libraries", method: "GET" },
	]);
});

test("destructive and fault acceptance entrypoints are fail-closed", async (t) => {
	const restore = spawnSync(
		process.execPath,
		[
			fileURLToPath(new URL("scripts/acceptance/restore-drill.mjs", root)),
			"--plan",
		],
		{ cwd: rootPath, encoding: "utf8" },
	);
	assert.equal(restore.status, 0, restore.stderr);
	const plan = JSON.parse(restore.stdout);
	assert.equal(typeof plan.destructive_project_allowed, "boolean");
	const blockedRestore = spawnSync(
		process.execPath,
		[fileURLToPath(new URL("scripts/acceptance/restore-drill.mjs", root))],
		{ cwd: rootPath, encoding: "utf8", env: {} },
	);
	assert.equal(blockedRestore.status, 2);
	assert.match(blockedRestore.stderr, /refusing destructive restore/);

	const provider = spawnSync(
		process.execPath,
		[fileURLToPath(new URL("scripts/acceptance/provider-faults.mjs", root))],
		{ cwd: rootPath, encoding: "utf8", env: {} },
	);
	assert.equal(provider.status, 2);
	assert.match(
		provider.stderr,
		/UNORAG_ACCEPT_PROVIDER_FAULTS=YES is required/,
	);

	const directory = await mkdtemp(join(tmpdir(), "unorag-upgrade-gate-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const previousPath = join(directory, "previous.env");
	const candidatePath = join(directory, "candidate.env");
	const digest = `ghcr.io/unorag/web@sha256:${"b".repeat(64)}`;
	await Promise.all([
		writeFile(previousPath, manifest("a".repeat(40), digest)),
		writeFile(candidatePath, manifest("c".repeat(40), digest)),
	]);
	const upgrade = spawnSync(
		process.execPath,
		[
			fileURLToPath(new URL("scripts/acceptance/upgrade-rollback.mjs", root)),
			"--previous-manifest",
			previousPath,
			"--candidate-manifest",
			candidatePath,
		],
		{ cwd: rootPath, encoding: "utf8", env: {} },
	);
	assert.equal(upgrade.status, 2);
	assert.match(
		upgrade.stderr,
		/UNORAG_ACCEPT_UPGRADE_ROLLBACK=YES is required/,
	);
});

test("acceptance Provider proxy requires auth and injects deterministic faults", async (t) => {
	const port = 20_000 + Math.floor(Math.random() * 20_000);
	const token = "acceptance-control-token";
	const child = spawn(
		process.execPath,
		[fileURLToPath(new URL("scripts/acceptance/fault-provider.mjs", root))],
		{
			cwd: rootPath,
			env: {
				...process.env,
				FAULT_PROVIDER_PORT: String(port),
				FAULT_PROVIDER_CONTROL_TOKEN: token,
			},
			stdio: "ignore",
		},
	);
	t.after(() => child.kill("SIGTERM"));
	const baseUrl = `http://127.0.0.1:${port}`;
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			if ((await fetch(`${baseUrl}/healthz`)).ok) break;
		} catch {
			await new Promise((resolveWait) => setTimeout(resolveWait, 20));
		}
		if (attempt === 49) assert.fail("fault Provider did not start");
	}
	assert.equal((await fetch(`${baseUrl}/__state`)).status, 403);
	const controlled = await fetch(`${baseUrl}/__control`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ embedding: "503", reset_counts: true }),
	});
	assert.equal(controlled.status, 200);
	const injected = await fetch(`${baseUrl}/v1/embeddings`, {
		method: "POST",
		body: "{}",
	});
	assert.equal(injected.status, 503);
	const state = await fetch(`${baseUrl}/__state`, {
		headers: { authorization: `Bearer ${token}` },
	});
	assert.equal((await state.json()).counts.embedding, 1);
});

test("acceptance overlay stays internal and only targets Provider endpoints", async () => {
	const [overlay, provider, gitignore] = await Promise.all([
		readFile(
			new URL("deploy/compose/docker-compose.acceptance-faults.yml", root),
			"utf8",
		),
		readFile(new URL("scripts/acceptance/fault-provider.mjs", root), "utf8"),
		readFile(new URL(".gitignore", root), "utf8"),
	]);
	assert.doesNotMatch(overlay, /^\s*ports:/m);
	assert.match(overlay, /restart: "no"/);
	assert.match(overlay, /ASK_JUDGE_TIMEOUT_MS:.*:-12000/);
	assert.match(overlay, /OPENAI_BASE_URL: http:\/\/fault-provider:9080\/v1/);
	assert.match(provider, /FAULT_PROVIDER_CONTROL_TOKEN/);
	assert.doesNotMatch(provider, /console\.log\([^)]*body/);
	for (const directory of [
		".provider-faults-work/",
		".release-gate-work/",
		".restore-work/",
		".upgrade-rollback-work/",
	])
		assert.match(gitignore, new RegExp(directory.replaceAll(".", "\\.")));
});
