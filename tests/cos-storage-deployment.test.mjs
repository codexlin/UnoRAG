import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	hasCommand,
	renderComposeConfig,
	renderHelm,
} from "./helpers/deployment-contracts.mjs";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Compose renders COS configuration from split public and secret inputs", async () => {
	const [install, runtime, advanced, secrets] = await Promise.all([
		source("deploy/compose/scripts/install.sh"),
		source("deploy/config/runtime.env.example"),
		source("deploy/config/runtime.advanced.env.example"),
		source("deploy/config/runtime.secret.example"),
	]);
	assert.match(install, /COS_BUCKET COS_REGION COS_SECRET_ID COS_SECRET_KEY/);
	assert.match(runtime, /^DOCUMENT_STORAGE_DRIVER=local$/m);
	assert.match(advanced, /^COS_PUBLIC_BASE_URL=$/m);
	assert.doesNotMatch(runtime, /^COS_SECRET_(ID|KEY)=/m);
	assert.match(secrets, /^COS_SECRET_ID=$/m);
	assert.match(secrets, /^COS_SECRET_KEY=$/m);

	const compose = renderComposeConfig({
		DOCUMENT_STORAGE_DRIVER: "cos",
		COS_BUCKET: "contract-bucket",
		COS_REGION: "ap-hongkong",
		COS_SECRET_ID: "contract-secret-id",
		COS_SECRET_KEY: "contract-secret-key",
	});
	for (const serviceName of ["web", "dbos-worker"]) {
		const environment = compose.services[serviceName].environment;
		assert.equal(environment.DOCUMENT_STORAGE_DRIVER, "cos");
		assert.equal(environment.COS_BUCKET, "contract-bucket");
		assert.equal(environment.COS_REGION, "ap-hongkong");
		assert.equal(environment.COS_SECRET_ID, "contract-secret-id");
		assert.equal(environment.COS_SECRET_KEY, "contract-secret-key");
	}
	assert.equal(
		"COS_SECRET_KEY" in (compose.services["dbos-control"].environment ?? {}),
		false,
	);
});

test("restore refuses missing confirmation and cross-driver backups before Docker mutation", async (t) => {
	const sandbox = await mkdtemp(join(tmpdir(), "unorag-restore-contract-"));
	t.after(() => rm(sandbox, { recursive: true, force: true }));
	const scriptsDir = join(sandbox, "deploy", "compose", "scripts");
	const configDir = join(sandbox, "deploy", "config");
	const backupDir = join(sandbox, "backup");
	await mkdir(scriptsDir, { recursive: true });
	await mkdir(configDir, { recursive: true });
	await mkdir(backupDir, { recursive: true });
	for (const script of ["restore.sh", "compose-env.sh"]) {
		await cp(
			new URL(`deploy/compose/scripts/${script}`, root),
			join(scriptsDir, script),
		);
	}
	await writeFile(
		join(configDir, "runtime.env"),
		"DOCUMENT_STORAGE_DRIVER=local\n",
	);
	await writeFile(join(configDir, "runtime.advanced.env"), "");
	await writeFile(join(configDir, "runtime.secret"), "");
	for (const artifact of [
		"postgres.sql",
		"dbos-system.dump",
		"qdrant.tgz",
		"documents.cos.txt",
	]) {
		await writeFile(join(backupDir, artifact), "contract fixture\n");
	}
	await writeFile(
		join(backupDir, "MANIFEST.txt"),
		"document_storage_driver=cos\n",
	);

	const restore = join(scriptsDir, "restore.sh");
	const withoutConfirmation = spawnSync("bash", [restore, backupDir], {
		encoding: "utf8",
	});
	assert.notEqual(withoutConfirmation.status, 0);
	assert.match(
		withoutConfirmation.stderr,
		/refusing restore without CONFIRM=YES/,
	);

	const crossDriver = spawnSync("bash", [restore, backupDir], {
		encoding: "utf8",
		env: { ...process.env, CONFIRM: "YES" },
	});
	assert.notEqual(crossDriver.status, 0);
	assert.match(
		crossDriver.stderr,
		/backup storage driver cos does not match runtime local/,
	);
});

test("deployment docs record the working CAM user-policy shape", async () => {
	const deployment = await source("docs/DEPLOYMENT.md");
	assert.match(deployment, /cos:PutObjectACL/);
	assert.match(
		deployment,
		/qcs::cos:ap-hongkong:uid\/1311896385:unobyte-1311896385\/org\/\*/,
	);
	assert.match(deployment, /name\/cos:PutObject/);
	assert.match(deployment, /prefix\/\//);
	assert.match(deployment, /pnpm smoke:cos/);
});

test("Helm renders COS and rejects incomplete or contradictory topology", (t) => {
	if (!hasCommand("helm", ["version", "--short"])) {
		t.skip("helm is not installed");
		return;
	}
	const valid = renderHelm([
		"--set",
		"objectStorage.driver=cos",
		"--set",
		"persistence.enabled=false",
		"--set",
		"objectStorage.cos.bucket=contract-bucket",
		"--set",
		"objectStorage.cos.region=ap-hongkong",
	]);
	assert.equal(valid.status, 0, valid.stderr);
	assert.match(valid.stdout, /DOCUMENT_STORAGE_DRIVER: "cos"/);
	assert.match(valid.stdout, /COS_BUCKET: "contract-bucket"/);
	assert.doesNotMatch(valid.stdout, /kind: PersistentVolumeClaim/);

	for (const args of [
		[
			"--set",
			"objectStorage.driver=cos",
			"--set",
			"persistence.enabled=true",
			"--set",
			"objectStorage.cos.bucket=contract-bucket",
			"--set",
			"objectStorage.cos.region=ap-hongkong",
		],
		["--set", "objectStorage.driver=cos", "--set", "persistence.enabled=false"],
		["--set", "objectStorage.driver=invalid"],
	]) {
		const invalid = renderHelm(args);
		assert.notEqual(invalid.status, 0);
	}
});
