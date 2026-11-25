import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { load } from "js-yaml";

const repoRoot = new URL("../", import.meta.url);

async function readRepoFile(relativePath) {
	return readFile(new URL(relativePath, repoRoot), "utf8");
}

async function createComposeSandbox(t, configOverrides = {}) {
	const sandbox = await mkdtemp(join(tmpdir(), "unorag-deploy-auto-"));
	t.after(() => rm(sandbox, { recursive: true, force: true }));

	const composeDir = join(sandbox, "deploy/compose");
	const scriptsDir = join(composeDir, "scripts");
	const configDir = join(sandbox, "deploy/config");
	const binDir = join(sandbox, "bin");
	await mkdir(scriptsDir, { recursive: true });
	await mkdir(configDir, { recursive: true });
	await mkdir(binDir, { recursive: true });

	for (const script of [
		"backup.sh",
		"compose-env.sh",
		"release-env.sh",
		"prune-release-images.sh",
		"remote-deploy.sh",
		"upgrade.sh",
	]) {
		const target = join(scriptsDir, script);
		await cp(new URL(`deploy/compose/scripts/${script}`, repoRoot), target);
		await chmod(target, 0o755);
	}
	await writeFile(join(composeDir, "docker-compose.yml"), "services: {}\n");

	const runtimeEnv = [
		`COMPOSE_PROJECT_NAME=${configOverrides.project ?? "unorag-test"}`,
		`DOCUMENT_STORAGE_DRIVER=${configOverrides.storageDriver ?? "cos"}`,
		"COS_BUCKET=private-bucket",
		"COS_REGION=ap-hongkong",
		"POSTGRES_USER=unorag",
		"POSTGRES_DB=unorag",
		"UNORAG_DBOS_DATABASE=unorag_dbos",
	].join("\n");
	await writeFile(join(configDir, "runtime.env"), `${runtimeEnv}\n`);

	const runtimeAdvanced =
		configOverrides.runtimeAdvanced ??
		[
			`UNORAG_WEB_IMAGE=ghcr.io/codexlin/unorag@sha256:${"1".repeat(64)}`,
			`UNORAG_WEB_MIGRATOR_IMAGE=ghcr.io/codexlin/unorag@sha256:${"2".repeat(64)}`,
			`UNORAG_WEB_OPS_IMAGE=ghcr.io/codexlin/unorag@sha256:${"3".repeat(64)}`,
			`UNORAG_DBOS_WORKER_IMAGE=ghcr.io/codexlin/unorag@sha256:${"4".repeat(64)}`,
			"UNORAG_DBOS_APPLICATION_VERSION=unorag-0123456789abcdef",
			"UNORAG_IMAGE_PLATFORM=linux/amd64",
		].join("\n");
	await writeFile(
		join(configDir, "runtime.advanced.env"),
		`${runtimeAdvanced}\n`,
	);
	await writeFile(join(configDir, "runtime.secret"), "POSTGRES_PASSWORD=x\n");

	return { sandbox, composeDir, scriptsDir, configDir, binDir };
}

test("backup.sh --retain verifies new backup, prunes excess eligible siblings, and never touches non-backup dirs", async (t) => {
	const { sandbox, scriptsDir, binDir } = await createComposeSandbox(t);
	const backupRoot = join(sandbox, "backups");
	await mkdir(backupRoot, { recursive: true });

	// Seed 3 eligible older backups + 2 unrelated directories that must never be deleted.
	for (const [name, createdAt] of [
		["pre-v0.4.0-20261120T000000Z", "2026-11-20T00:00:00Z"],
		["pre-v0.4.1-20261122T000000Z", "2026-11-22T00:00:00Z"],
		["unorag-20261123T000000Z", "2026-11-23T00:00:00Z"],
	]) {
		const dir = join(backupRoot, name);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "MANIFEST.txt"), `created_at=${createdAt}\n`);
		await writeFile(join(dir, "CHECKSUMS.sha256"), "dummy\n");
	}
	await mkdir(join(backupRoot, "manual-keep-forever"), { recursive: true });
	await writeFile(
		join(backupRoot, "manual-keep-forever/MANIFEST.txt"),
		"created_at=2025-01-01T00:00:00Z\n",
	);
	await writeFile(
		join(backupRoot, "manual-keep-forever/CHECKSUMS.sha256"),
		"dummy\n",
	);
	await mkdir(join(backupRoot, "pre-incomplete-no-checksum"), {
		recursive: true,
	});
	await writeFile(
		join(backupRoot, "pre-incomplete-no-checksum/MANIFEST.txt"),
		"created_at=2025-01-01T00:00:00Z\n",
	);

	const fakeDocker = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "compose") {
	if (args.includes("exec") && args.includes("pg_dump")) {
		process.stdout.write("-- fixture dump\\n");
		process.exit(0);
	}
	if (args.includes("ps")) {
		process.stdout.write("container-1\\n");
		process.exit(0);
	}
	process.exit(0);
}
if (args[0] === "run") {
	const vIndex = args.findIndex((a) => a.endsWith(":/backup"));
	if (vIndex >= 0) {
		const hostDir = args[vIndex].slice(0, -":/backup".length);
		fs.writeFileSync(path.join(hostDir, "qdrant.tgz"), "fixture-qdrant");
	}
	process.exit(0);
}
process.exit(0);
`;
	await writeFile(join(binDir, "docker"), fakeDocker, { mode: 0o755 });

	const invalidRetain = spawnSync(
		"bash",
		[
			join(scriptsDir, "backup.sh"),
			"--retain",
			"0",
			join(backupRoot, "pre-bad"),
		],
		{
			encoding: "utf8",
			env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
		},
	);
	assert.notEqual(invalidRetain.status, 0);
	assert.match(invalidRetain.stderr, /positive integer/);

	const currentOut = join(backupRoot, "pre-v0.4.2-20261124T184245Z");
	const ok = spawnSync(
		"bash",
		[join(scriptsDir, "backup.sh"), "--retain", "2", currentOut],
		{
			encoding: "utf8",
			env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
		},
	);
	assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);

	const remaining = (await readdir(backupRoot)).sort();
	assert.deepEqual(remaining, [
		"manual-keep-forever",
		"pre-incomplete-no-checksum",
		"pre-v0.4.2-20261124T184245Z",
		"unorag-20261123T000000Z",
	]);
});

test("prune-release-images.sh preserves active, rollback, extra manifest, and container-referenced images without --force or volume pruning", async (t) => {
	const { sandbox, composeDir, scriptsDir, binDir } =
		await createComposeSandbox(t);
	const stateDir = join(composeDir, ".upgrade-state");
	await mkdir(stateDir, { recursive: true });
	await writeFile(
		join(stateDir, "previous-images.env"),
		`${[
			`UNORAG_WEB_IMAGE=ghcr.io/codexlin/unorag@sha256:${"5".repeat(64)}`,
			`UNORAG_WEB_MIGRATOR_IMAGE=ghcr.io/codexlin/unorag@sha256:${"6".repeat(64)}`,
			`UNORAG_WEB_OPS_IMAGE=ghcr.io/codexlin/unorag@sha256:${"7".repeat(64)}`,
			`UNORAG_DBOS_WORKER_IMAGE=ghcr.io/codexlin/unorag@sha256:${"8".repeat(64)}`,
		].join("\n")}\n`,
	);

	const logPath = join(sandbox, "docker-calls.jsonl");
	const fakeDocker = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + "\\n");

const refToId = {
	"ghcr.io/codexlin/unorag@sha256:${"1".repeat(64)}": "sha256:active-web",
	"ghcr.io/codexlin/unorag@sha256:${"2".repeat(64)}": "sha256:active-mig",
	"ghcr.io/codexlin/unorag@sha256:${"3".repeat(64)}": "sha256:active-ops",
	"ghcr.io/codexlin/unorag@sha256:${"4".repeat(64)}": "sha256:active-wrk",
	"ghcr.io/codexlin/unorag@sha256:${"5".repeat(64)}": "sha256:prev-web",
	"ghcr.io/codexlin/unorag@sha256:${"6".repeat(64)}": "sha256:prev-mig",
	"ghcr.io/codexlin/unorag@sha256:${"7".repeat(64)}": "sha256:prev-ops",
	"ghcr.io/codexlin/unorag@sha256:${"8".repeat(64)}": "sha256:prev-wrk",
};

if (args[0] === "ps" && args[1] === "-aq") {
	if (args.includes("label=com.docker.compose.service=migrate-web")) {
		process.stdout.write("exited-unorag-migrate-1\\n");
	} else if (args.length === 2) {
		process.stdout.write("running-web-1\\nunrelated-reelori-1\\npinned-old-container\\n");
	}
	process.exit(0);
}
if (args[0] === "rm") {
	process.exit(0);
}
if (args[0] === "inspect") {
	const cid = args.at(-1);
	const map = {
		"running-web-1": "sha256:active-web",
		"unrelated-reelori-1": "sha256:reelori-img",
		"pinned-old-container": "sha256:still-used-old-unorag",
	};
	process.stdout.write((map[cid] || "") + "\\n");
	process.exit(0);
}
if (args[0] === "image" && args[1] === "inspect") {
	const ref = args.at(-1);
	if (!refToId[ref]) process.exit(1);
	process.stdout.write(refToId[ref] + "\\n");
	process.exit(0);
}
if (args[0] === "images") {
	const rows = [
		["sha256:active-web", "ghcr.io/codexlin/unorag", "<none>", "sha256:${"1".repeat(64)}"],
		["sha256:prev-web", "ghcr.io/codexlin/unorag", "<none>", "sha256:${"5".repeat(64)}"],
		["sha256:still-used-old-unorag", "ghcr.io/codexlin/unorag", "web-v0.3.9", "sha256:${"9".repeat(64)}"],
		["sha256:obsolete-tagged", "ghcr.io/codexlin/unorag", "web-v0.3.5", "sha256:${"a".repeat(64)}"],
		["sha256:obsolete-digest-only", "ghcr.io/codexlin/unorag", "<none>", "sha256:${"b".repeat(64)}"],
		["sha256:reelori-img", "ghcr.io/other/reelori", "latest", "sha256:${"c".repeat(64)}"],
	];
	process.stdout.write(rows.map((r) => r.join("\\t")).join("\\n") + "\\n");
	process.exit(0);
}
if (args[0] === "image" && args[1] === "rm") {
	if (args.includes("-f") || args.includes("--force")) {
		console.error("FORBIDDEN --force flag");
		process.exit(99);
	}
	process.exit(0);
}
if (args[0] === "system" && args[1] === "df") {
	process.stdout.write("TYPE TOTAL ACTIVE SIZE RECLAIMABLE\\n");
	process.exit(0);
}
process.exit(0);
`;
	await writeFile(join(binDir, "docker"), fakeDocker, { mode: 0o755 });

	// Dry run must perform zero removals.
	await writeFile(logPath, "");
	const dryRun = spawnSync(
		"bash",
		[
			join(scriptsDir, "prune-release-images.sh"),
			"--dry-run",
			"--prune-exited-ops",
		],
		{
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${binDir}:${process.env.PATH}`,
				CALL_LOG: logPath,
			},
		},
	);
	assert.equal(dryRun.status, 0, `${dryRun.stdout}\n${dryRun.stderr}`);
	const dryCalls = (await readFile(logPath, "utf8"))
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
	assert.equal(
		dryCalls.some((c) => c[0] === "rm" || (c[0] === "image" && c[1] === "rm")),
		false,
	);

	// Real prune removes only the 2 unreferenced obsolete UnoRAG images + 1 exited migrate container.
	await writeFile(logPath, "");
	const realRun = spawnSync(
		"bash",
		[join(scriptsDir, "prune-release-images.sh"), "--prune-exited-ops"],
		{
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${binDir}:${process.env.PATH}`,
				CALL_LOG: logPath,
			},
		},
	);
	assert.equal(realRun.status, 0, `${realRun.stdout}\n${realRun.stderr}`);
	const calls = (await readFile(logPath, "utf8"))
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));

	assert.deepEqual(
		calls.filter((c) => c[0] === "rm"),
		[["rm", "exited-unorag-migrate-1"]],
	);
	assert.deepEqual(
		calls.filter((c) => c[0] === "image" && c[1] === "rm"),
		[
			["image", "rm", "ghcr.io/codexlin/unorag:web-v0.3.5"],
			["image", "rm", `ghcr.io/codexlin/unorag@sha256:${"b".repeat(64)}`],
		],
	);
	assert.equal(
		calls.some(
			(c) => c[0] === "volume" || (c[0] === "system" && c[1] === "prune"),
		),
		false,
	);
});

test("remote-deploy.sh rejects unsigned manifests and revision mismatches fail-closed", async (t) => {
	const { sandbox, scriptsDir } = await createComposeSandbox(t);
	const sha = "a".repeat(40);
	const manifest = join(sandbox, "release-ghcr.env");

	const writeManifest = (overrides = {}) =>
		writeFile(
			manifest,
			`${[
				`UNORAG_WEB_IMAGE=ghcr.io/codexlin/unorag@sha256:${"1".repeat(64)}`,
				`UNORAG_WEB_MIGRATOR_IMAGE=ghcr.io/codexlin/unorag@sha256:${"2".repeat(64)}`,
				`UNORAG_WEB_OPS_IMAGE=ghcr.io/codexlin/unorag@sha256:${"3".repeat(64)}`,
				`UNORAG_DBOS_WORKER_IMAGE=ghcr.io/codexlin/unorag@sha256:${"4".repeat(64)}`,
				`UNORAG_DBOS_APPLICATION_VERSION=${overrides.dbos ?? `unorag-${sha.slice(0, 16)}`}`,
				"UNORAG_IMAGE_PLATFORM=linux/amd64",
				`UNORAG_VERSION=${overrides.version ?? "0.4.3"}`,
				`UNORAG_REVISION=${overrides.revision ?? sha}`,
				`UNORAG_VERIFY_IMAGE_SIGNATURES=${overrides.verifySig ?? "true"}`,
			].join("\n")}\n`,
		);

	await writeManifest({ verifySig: "false" });
	const unsigned = spawnSync(
		"bash",
		[
			join(scriptsDir, "remote-deploy.sh"),
			"--manifest",
			manifest,
			"--release-tag",
			"v0.4.3",
			"--expected-revision",
			sha,
		],
		{ encoding: "utf8" },
	);
	assert.notEqual(unsigned.status, 0);
	assert.match(unsigned.stderr, /UNORAG_VERIFY_IMAGE_SIGNATURES=true/);

	await writeManifest({ revision: "b".repeat(40) });
	const revMismatch = spawnSync(
		"bash",
		[
			join(scriptsDir, "remote-deploy.sh"),
			"--manifest",
			manifest,
			"--release-tag",
			"v0.4.3",
			"--expected-revision",
			sha,
		],
		{ encoding: "utf8" },
	);
	assert.notEqual(revMismatch.status, 0);
	assert.match(revMismatch.stderr, /does not match expected revision/);
});

test("remote-deploy.sh runs backup, upgrade, and inspect-lifecycle without overriding compose command", async (t) => {
	const compose = load(await readRepoFile("deploy/compose/docker-compose.yml"));
	const inspectService = compose.services["inspect-lifecycle"];
	assert.deepEqual(inspectService.command, [
		"node",
		"scripts/inspect-lifecycle.mjs",
		"--fail-on-dead",
		"--fail-on-stuck",
		"--fail-on-acl-projection",
	]);

	const { sandbox, scriptsDir, binDir } = await createComposeSandbox(t);
	const sha = "a".repeat(40);
	const manifest = join(sandbox, "release-ghcr.env");
	const callLog = join(sandbox, "calls.jsonl");
	await writeFile(callLog, "");
	await writeFile(
		manifest,
		`${[
			`UNORAG_WEB_IMAGE=ghcr.io/codexlin/unorag@sha256:${"1".repeat(64)}`,
			`UNORAG_WEB_MIGRATOR_IMAGE=ghcr.io/codexlin/unorag@sha256:${"2".repeat(64)}`,
			`UNORAG_WEB_OPS_IMAGE=ghcr.io/codexlin/unorag@sha256:${"3".repeat(64)}`,
			`UNORAG_DBOS_WORKER_IMAGE=ghcr.io/codexlin/unorag@sha256:${"4".repeat(64)}`,
			`UNORAG_DBOS_APPLICATION_VERSION=unorag-${sha.slice(0, 16)}`,
			"UNORAG_IMAGE_PLATFORM=linux/amd64",
			"UNORAG_VERSION=0.4.3",
			`UNORAG_REVISION=${sha}`,
			"UNORAG_VERIFY_IMAGE_SIGNATURES=true",
		].join("\n")}\n`,
	);

	const stubScript = (name) => `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ tool: ${JSON.stringify(name)}, args: process.argv.slice(2) }) + "\\n");
`;
	await writeFile(join(scriptsDir, "backup.sh"), stubScript("backup"), {
		mode: 0o755,
	});
	await writeFile(join(scriptsDir, "upgrade.sh"), stubScript("upgrade"), {
		mode: 0o755,
	});
	await writeFile(join(binDir, "docker"), stubScript("docker"), {
		mode: 0o755,
	});

	const backupRoot = join(sandbox, "backups");
	const result = spawnSync(
		"bash",
		[
			join(scriptsDir, "remote-deploy.sh"),
			"--manifest",
			manifest,
			"--release-tag",
			"v0.4.3",
			"--expected-revision",
			sha,
			"--backup-root",
			backupRoot,
			"--backup-retain",
			"3",
			"--prune-old-images",
			"--skip-smoke",
		],
		{
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${binDir}:${process.env.PATH}`,
				CALL_LOG: callLog,
			},
		},
	);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

	const calls = (await readFile(callLog, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));

	const backupCall = calls.find((c) => c.tool === "backup");
	assert.ok(backupCall);
	assert.equal(backupCall.args[0], "--retain");
	assert.equal(backupCall.args[1], "3");
	assert.match(backupCall.args[2], /\/backups\/pre-v0\.4\.3-/);

	const upgradeCall = calls.find((c) => c.tool === "upgrade");
	assert.deepEqual(upgradeCall?.args, [
		"--manifest",
		manifest,
		"--skip-smoke",
		"--prune-old-images",
	]);

	const inspectCall = calls.find(
		(c) => c.tool === "docker" && c.args.includes("inspect-lifecycle"),
	);
	assert.ok(inspectCall);
	// Passing extra flags after `inspect-lifecycle` overrides the service `command:`
	// (`node scripts/inspect-lifecycle.mjs --fail-on-dead ...`) and causes `node: bad option`.
	assert.equal(inspectCall.args.at(-1), "inspect-lifecycle");
});

test("deploy.yml enforces pre-approval verification, GitHub Environment approval gate, strict SSH host checks, and valid bash syntax", async () => {
	const raw = await readRepoFile(".github/workflows/deploy.yml");
	const workflow = load(raw);

	assert.equal(workflow.name, "deploy");
	assert.deepEqual(workflow.permissions, { contents: "read" });
	assert.ok(workflow.on.workflow_dispatch?.inputs?.environment);
	assert.ok(workflow.on.workflow_dispatch?.inputs?.release_tag);
	assert.deepEqual(workflow.on.release, { types: ["published"] });

	const prepare = workflow.jobs.prepare;
	const deploy = workflow.jobs.deploy;
	assert.equal(prepare.environment, undefined);
	assert.equal(deploy.needs, "prepare");
	assert.equal(
		deploy.environment.name,
		`\${{ needs.prepare.outputs.environment }}`,
	);
	assert.equal(deploy.concurrency["cancel-in-progress"], false);

	// Prepare job must verify SHA256SUMS + Cosign pinned by commit SHA without SSH secrets.
	const prepareText = JSON.stringify(prepare);
	assert.doesNotMatch(prepareText, /DEPLOY_SSH_PRIVATE_KEY/);
	assert.match(prepareText, /sigstore\/cosign-installer@[a-f0-9]{40}\b/);
	assert.match(prepareText, /sha256sum --check --strict/);
	assert.match(prepareText, /mk_release_verify_images/);

	// Deploy job must enforce strict host key verification, fail-closed health checks, and key cleanup.
	const deployText = JSON.stringify(deploy);
	assert.match(deployText, /StrictHostKeyChecking yes/);
	assert.doesNotMatch(deployText, /StrictHostKeyChecking[ =]+no/i);
	assert.match(deployText, /DEPLOY_SSH_KNOWN_HOSTS/);
	assert.match(deployText, /remote-deploy\.sh/);
	assert.match(deployText, /\/api\/rag\/health/);
	assert.match(deployText, /\.image_digest == \$digest/);
	assert.ok(
		deploy.steps.some(
			(step) => step.if === "always()" && /unorag-ssh/.test(step.run ?? ""),
		),
	);

	// Every shell step in deploy.yml must pass bash -n syntax validation.
	for (const job of [prepare, deploy]) {
		for (const step of job.steps) {
			if (!step.run) continue;
			const syntax = spawnSync("bash", ["-n"], {
				input: step.run,
				encoding: "utf8",
			});
			assert.equal(
				syntax.status,
				0,
				`bash syntax error in step "${step.name}": ${syntax.stderr}`,
			);
		}
	}
});
