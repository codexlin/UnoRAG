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

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("deployment inputs map to one application environment contract", async () => {
	const [
		runtime,
		advanced,
		compose,
		values,
		configMap,
		dbos,
		telemetry,
		worker,
		health,
	] = await Promise.all([
		source("deploy/config/runtime.env.example"),
		source("deploy/config/runtime.advanced.env.example"),
		source("deploy/compose/docker-compose.yml"),
		source("deploy/helm/unorag/values.yaml"),
		source("deploy/helm/unorag/templates/configmap.yaml"),
		source("deploy/helm/unorag/templates/dbos-deployments.yaml"),
		source("src/lib/observability/telemetry.ts"),
		source("src/worker/production-ports.ts"),
		source("src/server/observability/provider-health.ts"),
	]);

	assert.match(runtime, /^LLM_BASE_URL=/m);
	assert.equal(
		(runtime.match(/^[A-Z][A-Z0-9_]*=/gm) ?? []).length,
		15,
		"the common runtime surface must stay intentionally small",
	);
	assert.doesNotMatch(runtime, /^MINERU_SELF_HOSTED_URL=/m);
	assert.doesNotMatch(runtime, /^UNORAG_DBOS_/m);
	assert.doesNotMatch(runtime, /^OTEL_/m);
	assert.match(advanced, /^MINERU_SELF_HOSTED_URL=/m);
	assert.match(advanced, /^UNORAG_DBOS_LISTEN_QUEUES=/m);
	assert.match(advanced, /^OTEL_SDK_DISABLED=/m);
	assert.doesNotMatch(runtime, /^MINERU_URL=/m);
	assert.doesNotMatch(advanced, /^MINERU_URL=/m);

	assert.match(compose, /APP_ENV: \$\{APP_ENV:-production\}/);
	assert.match(
		compose,
		/OPENAI_BASE_URL: \$\{LLM_BASE_URL:\?LLM_BASE_URL required\}/,
	);
	assert.doesNotMatch(compose, /^\s+MINERU_URL:/m);

	assert.match(values, /^\s+llmBaseUrl: ""$/m);
	assert.doesNotMatch(values, /^\s+openaiBaseUrl:/m);
	assert.doesNotMatch(values, /^\s+mineruUrl:/m);
	assert.match(configMap, /APP_ENV:.*config\.appEnv/);
	assert.match(configMap, /OPENAI_BASE_URL:.*config\.llmBaseUrl/);
	assert.match(configMap, /TS_RETRIEVAL_HYBRID_ENABLED/);
	assert.match(configMap, /TS_RETRIEVAL_RERANK_ENABLED/);
	assert.match(configMap, /SESSION_MEMORY_TTL_SECONDS/);
	assert.doesNotMatch(configMap, /MINERU_URL/);
	assert.doesNotMatch(dbos, /config\.openaiBaseUrl|config\.mineruUrl/);
	assert.doesNotMatch(dbos, /name: MINERU_URL/);

	assert.match(telemetry, /environment\.UNORAG_VERSION/);
	assert.doesNotMatch(telemetry, /UNORAG_RELEASE_VERSION/);
	assert.doesNotMatch(worker, /process\.env\.MINERU_URL/);
	assert.doesNotMatch(health, /environment\.MINERU_URL/);
});

test("Helm gives Web and Worker the same canonical model endpoint", (t) => {
	const probe = spawnSync("helm", ["version", "--short"], {
		encoding: "utf8",
	});
	if (probe.status !== 0) {
		t.skip("helm is not installed");
		return;
	}
	const chart = new URL("deploy/helm/unorag", root).pathname;
	const render = spawnSync(
		"helm",
		[
			"template",
			"unorag",
			chart,
			"--set",
			"config.llmBaseUrl=https://models.example/v1",
		],
		{ encoding: "utf8" },
	);
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
