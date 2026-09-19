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
	const [runtime, compose, values, configMap, dbos, telemetry, worker, health] =
		await Promise.all([
			source("deploy/config/runtime.env.example"),
			source("deploy/compose/docker-compose.yml"),
			source("deploy/helm/unorag/values.yaml"),
			source("deploy/helm/unorag/templates/configmap.yaml"),
			source("deploy/helm/unorag/templates/dbos-deployments.yaml"),
			source("src/lib/observability/telemetry.ts"),
			source("src/worker/production-ports.ts"),
			source("src/server/observability/provider-health.ts"),
		]);

	assert.match(runtime, /^LLM_BASE_URL=/m);
	assert.match(runtime, /^MINERU_SELF_HOSTED_URL=/m);
	assert.doesNotMatch(runtime, /^MINERU_URL=/m);

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

test("config reconciliation migrates and retires MINERU_URL", async (t) => {
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
	for (const name of ["runtime.env", "runtime.secret", "bootstrap.env"]) {
		await cp(
			new URL(`deploy/config/${name}.example`, root),
			join(configDir, `${name}.example`),
		);
		await cp(
			new URL(`deploy/config/${name}.example`, root),
			join(configDir, name),
		);
	}
	const runtimePath = join(configDir, "runtime.env");
	const runtime = await readFile(runtimePath, "utf8");
	await writeFile(
		runtimePath,
		`${runtime.replace(/^MINERU_SELF_HOSTED_URL=.*$/m, "MINERU_SELF_HOSTED_URL=")}\nMINERU_URL=http://legacy-mineru:6006\n`,
	);

	const result = spawnSync("bash", [join(scriptsDir, "init-config.sh")], {
		cwd: composeDir,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
	const reconciled = await readFile(runtimePath, "utf8");
	assert.match(
		reconciled,
		/^MINERU_SELF_HOSTED_URL=http:\/\/legacy-mineru:6006$/m,
	);
	assert.doesNotMatch(reconciled, /^MINERU_URL=/m);
});
