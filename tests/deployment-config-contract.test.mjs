import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	hasCommand,
	renderComposeConfig,
	renderHelm,
} from "./helpers/deployment-contracts.mjs";

const root = new URL("../", import.meta.url);

function parseEnvContract(contents) {
	return new Map(
		contents
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#"))
			.map((line) => {
				const separator = line.indexOf("=");
				assert.notEqual(separator, -1, `invalid env contract line: ${line}`);
				return [line.slice(0, separator), line.slice(separator + 1)];
			}),
	);
}

test("deployment inputs map to one application environment contract", async () => {
	const [runtimeContents, advancedContents] = await Promise.all([
		readFile(new URL("deploy/config/runtime.env.example", root), "utf8"),
		readFile(
			new URL("deploy/config/runtime.advanced.env.example", root),
			"utf8",
		),
	]);
	const runtime = parseEnvContract(runtimeContents);
	const advanced = parseEnvContract(advancedContents);

	assert.equal(runtime.has("LLM_BASE_URL"), true);
	assert.equal(
		runtime.size,
		15,
		"the common runtime surface must stay intentionally small",
	);
	for (const name of [
		"MINERU_SELF_HOSTED_URL",
		"UNORAG_DBOS_LISTEN_QUEUES",
		"OTEL_SDK_DISABLED",
	]) {
		assert.equal(
			runtime.has(name),
			false,
			`${name} stays out of common config`,
		);
		assert.equal(
			advanced.has(name),
			true,
			`${name} is available in advanced config`,
		);
	}
	assert.equal(runtime.has("MINERU_URL"), false);
	assert.equal(advanced.has("MINERU_URL"), false);

	const compose = renderComposeConfig();
	assert.equal(compose.services.web.environment.APP_ENV, "production");
	assert.equal(
		compose.services.web.environment.OPENAI_BASE_URL,
		"https://models.example/v1",
	);
	assert.equal(
		compose.services["dbos-worker"].environment.OPENAI_BASE_URL,
		"https://models.example/v1",
	);
	assert.equal(
		compose.services.web.environment.TS_RETRIEVAL_HYBRID_ENABLED,
		advanced.get("TS_RETRIEVAL_HYBRID_ENABLED"),
	);
	assert.equal(
		compose.services.web.environment.TS_RETRIEVAL_RERANK_ENABLED,
		advanced.get("TS_RETRIEVAL_RERANK_ENABLED"),
	);
	assert.equal(
		compose.services.web.environment.SESSION_MEMORY_TTL_SECONDS,
		advanced.get("SESSION_MEMORY_TTL_SECONDS"),
	);
	for (const service of Object.values(compose.services)) {
		assert.equal("MINERU_URL" in (service.environment ?? {}), false);
	}
});

test("Helm gives Web and Worker the same canonical model endpoint", (t) => {
	if (!hasCommand("helm", ["version", "--short"])) {
		t.skip("helm is not installed");
		return;
	}
	const render = renderHelm();
	assert.equal(render.status, 0, render.stderr);
	assert.equal(
		(render.stdout.match(/OPENAI_BASE_URL/g) ?? []).length,
		2,
		"ConfigMap and DBOS Worker must use the same endpoint",
	);
	assert.equal(
		(render.stdout.match(/https:\/\/models\.example\/v1/g) ?? []).length,
		2,
	);
	assert.doesNotMatch(render.stdout, /MINERU_URL/);
	assert.equal((render.stdout.match(/APP_ENV/g) ?? []).length, 3);
	assert.match(render.stdout, /APP_ENV:\s+"production"/);
});

test("config reconciliation layers old runtime values without losing custom settings", async (t) => {
	const sandbox = await mkdtemp(join(tmpdir(), "unorag-config-contract-"));
	t.after(() => rm(sandbox, { recursive: true, force: true }));
	const composeDir = join(sandbox, "deploy", "compose");
	const scriptsDir = join(composeDir, "scripts");
	const configDir = join(sandbox, "deploy", "config");
	await mkdir(scriptsDir, { recursive: true });
	await mkdir(configDir, { recursive: true });

	await cp(
		new URL("deploy/compose/scripts/init-config.sh", root),
		join(scriptsDir, "init-config.sh"),
	);
	await chmod(join(scriptsDir, "init-config.sh"), 0o755);
	for (const name of [
		"runtime.env",
		"runtime.advanced.env",
		"runtime.secret",
		"bootstrap.env",
	]) {
		await cp(
			new URL(`deploy/config/${name}.example`, root),
			join(configDir, `${name}.example`),
		);
		if (name !== "runtime.advanced.env") {
			await cp(
				new URL(`deploy/config/${name}.example`, root),
				join(configDir, name),
			);
		}
	}
	const runtimePath = join(configDir, "runtime.env");
	const advancedPath = join(configDir, "runtime.advanced.env");
	const [runtime, advancedExample] = await Promise.all([
		readFile(runtimePath, "utf8"),
		readFile(join(configDir, "runtime.advanced.env.example"), "utf8"),
	]);
	await writeFile(
		runtimePath,
		`${runtime.replace(/^HTTP_PORT=.*$/m, "HTTP_PORT=8088")}\n${advancedExample
			.replace(/^MINERU_SELF_HOSTED_URL=.*$/m, "")
			.replace(
				/^DBOS_INGEST_AUTO_CONCURRENCY=.*$/m,
				"DBOS_INGEST_AUTO_CONCURRENCY=7",
			)}\nMINERU_URL=http://legacy-mineru:6006\nCUSTOM_OPERATOR_SETTING=preserved\n`,
	);

	const result = spawnSync("bash", [join(scriptsDir, "init-config.sh")], {
		cwd: composeDir,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
	const [reconciled, advanced] = await Promise.all([
		readFile(runtimePath, "utf8"),
		readFile(advancedPath, "utf8"),
	]);
	assert.match(reconciled, /^HTTP_PORT=8088$/m);
	assert.equal((reconciled.match(/^[A-Z][A-Z0-9_]*=/gm) ?? []).length, 15);
	assert.doesNotMatch(reconciled, /^DBOS_INGEST_AUTO_CONCURRENCY=/m);
	assert.match(
		advanced,
		/^MINERU_SELF_HOSTED_URL=http:\/\/legacy-mineru:6006$/m,
	);
	assert.match(advanced, /^DBOS_INGEST_AUTO_CONCURRENCY=7$/m);
	assert.match(advanced, /^CUSTOM_OPERATOR_SETTING=preserved$/m);
	assert.doesNotMatch(advanced, /^MINERU_URL=/m);
});
