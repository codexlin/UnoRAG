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
import { loadAll } from "js-yaml";

import {
	hasCommand,
	renderComposeConfig,
	renderHelm,
} from "./helpers/deployment-contracts.mjs";

const root = new URL("../", import.meta.url);

test("full development mounts current source onto the existing private stack without publishing data services", () => {
	const overlay = "deploy/compose/docker-compose.development.yml";
	const dev = renderComposeConfig({}, [overlay]);
	for (const name of ["web", "dbos-worker", "dbos-control"]) {
		const service = dev.services[name];
		assert.equal(service.image, "unorag-development:local");
		assert.equal(service.build.target, "development");
		assert.equal(service.environment.NODE_ENV, "development");
		assert.equal(
			service.environment.UNORAG_DBOS_APPLICATION_VERSION,
			"dev-local",
		);
		assert.ok(
			service.volumes.some(
				(mount) => mount.type === "bind" && mount.target === "/repo",
			),
		);
		assert.ok(
			service.volumes.some(
				(mount) =>
					mount.type === "volume" && mount.target === "/repo/node_modules",
			),
		);
	}
	assert.deepEqual(dev.services["dbos-worker"].command, [
		"pnpm",
		"exec",
		"tsx",
		"watch",
		"src/worker/entry.ts",
	]);
	assert.equal(dev.services.web.ports[0].host_ip, "127.0.0.1");
	assert.equal(dev.services.web.environment.UNORAG_DEV_ORIGINS, "127.0.0.1,");
	for (const name of ["postgres", "redis", "qdrant"])
		assert.equal(dev.services[name].ports, undefined);
	for (const name of ["web", "dbos-worker"])
		assert.ok(
			dev.services[name].volumes.some(
				(mount) => mount.source === "document_storage",
			),
		);
	const lan = renderComposeConfig(
		{
			UNORAG_DEV_BIND: "0.0.0.0",
			UNORAG_DEV_PORT: "3001",
			UNORAG_DEV_ORIGINS: "192.168.1.4",
		},
		[overlay],
	);
	assert.equal(lan.services.web.ports[0].host_ip, "0.0.0.0");
	assert.equal(
		lan.services.web.environment.UNORAG_DEV_ORIGINS,
		"127.0.0.1,192.168.1.4",
	);
	const production = renderComposeConfig();
	assert.equal(production.services.web.environment.NODE_ENV, "production");
	assert.equal(production.services.web.ports, undefined);
});

test("explicit LAN development origins never relax production security headers", () => {
	const load = (mode) => {
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"-e",
				'import exported from "./next.config.ts"; const config = exported.default ?? exported; console.log(JSON.stringify({origins: config.allowedDevOrigins ?? [], headers: await config.headers()}));',
			],
			{
				cwd: root,
				encoding: "utf8",
				env: {
					...process.env,
					NODE_ENV: mode,
					UNORAG_DEV_ORIGINS: "192.168.1.4, 10.0.0.2, ",
				},
			},
		);
		assert.equal(result.status, 0, result.stderr);
		return JSON.parse(result.stdout);
	};
	assert.deepEqual(load("development").origins, ["192.168.1.4", "10.0.0.2"]);
	const production = load("production");
	assert.deepEqual(production.origins, []);
	const headers = new Map(
		production.headers
			.find((route) => route.source === "/:path*")
			.headers.map(({ key, value }) => [key, value]),
	);
	assert.equal(headers.get("X-Frame-Options"), "DENY");
	assert.match(headers.get("Strict-Transport-Security"), /max-age=31536000/);
	assert.match(
		headers.get("Content-Security-Policy"),
		/upgrade-insecure-requests/,
	);
	assert.doesNotMatch(headers.get("Content-Security-Policy"), /unsafe-eval/);
});

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

test("release pushes execute the complete read-only CI gates", async () => {
	const [ci] = loadAll(
		await readFile(new URL(".github/workflows/ci.yml", root), "utf8"),
	);
	assert.ok(Object.hasOwn(ci.on, "pull_request"));
	assert.ok(ci.on.push.branches.includes("main"));
	assert.ok(ci.on.push.branches.includes("release/**"));
	assert.deepEqual(ci.permissions, { contents: "read" });
	for (const name of [
		"secrets",
		"brand-residue",
		"lint-diff",
		"offline-evaluation",
		"web",
		"docker-build",
	]) {
		assert.ok(ci.jobs[name], `missing required CI gate: ${name}`);
		assert.equal(ci.jobs[name].if, undefined);
	}
});

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
		compose.services.web.environment.LLM_BASE_URL,
		"https://models.example/v1",
	);
	assert.equal(
		compose.services["dbos-worker"].environment.LLM_BASE_URL,
		"https://models.example/v1",
	);
	assert.equal(advanced.get("TS_RETRIEVAL_HYBRID_ENABLED"), "true");
	assert.equal(
		compose.services.web.environment.TS_RETRIEVAL_HYBRID_ENABLED,
		"true",
	);
	assert.equal(
		renderComposeConfig({ TS_RETRIEVAL_HYBRID_ENABLED: "" }).services.web
			.environment.TS_RETRIEVAL_HYBRID_ENABLED,
		"true",
	);
	assert.equal(
		renderComposeConfig({ TS_RETRIEVAL_HYBRID_ENABLED: "false" }).services.web
			.environment.TS_RETRIEVAL_HYBRID_ENABLED,
		"false",
	);
	assert.equal(
		compose.services.web.environment.TS_RETRIEVAL_RERANK_ENABLED,
		advanced.get("TS_RETRIEVAL_RERANK_ENABLED"),
	);
	assert.equal(compose.services.web.environment.AI_INCLUDE_USAGE, "true");
	assert.equal(advanced.get("AI_INCLUDE_USAGE"), "true");
	for (const service of ["web", "dbos-worker"]) {
		assert.equal(
			"QDRANT_SERVER_HYBRID_ENABLED" in
				(compose.services[service].environment ?? {}),
			false,
		);
		assert.equal(
			"TS_RETRIEVAL_CORPUS_LIMIT" in
				(compose.services[service].environment ?? {}),
			false,
		);
	}
	for (const [name, value] of Object.entries({
		CONTEXTUAL_RETRIEVAL_ENABLED: "false",
		CONTEXTUAL_RETRIEVAL_MAX_CHUNKS: "40",
		CONTEXTUAL_RETRIEVAL_TIMEOUT_MS: "1000",
	})) {
		assert.equal(advanced.has(name), name === "CONTEXTUAL_RETRIEVAL_ENABLED");
		assert.equal(compose.services["dbos-worker"].environment[name], value);
		assert.equal(compose.services.web.environment[name], undefined);
	}
	assert.equal(
		renderComposeConfig({ CONTEXTUAL_RETRIEVAL_ENABLED: "true" }).services[
			"dbos-worker"
		].environment.CONTEXTUAL_RETRIEVAL_ENABLED,
		"true",
	);
	assert.equal(
		renderComposeConfig({ AI_INCLUDE_USAGE: "false" }).services.web.environment
			.AI_INCLUDE_USAGE,
		"false",
	);
	for (const service of Object.values(compose.services)) {
		assert.equal("MINERU_URL" in (service.environment ?? {}), false);
	}
});

test("omitted engineering settings retain their Compose defaults and accept overrides", async () => {
	const advanced = parseEnvContract(
		await readFile(
			new URL("deploy/config/runtime.advanced.env.example", root),
			"utf8",
		),
	);
	const defaults = {
		web: {
			DATABASE_POOL_MAX: "10",
			SESSION_MEMORY_TTL_SECONDS: "3600",
			ASK_JUDGE_TIMEOUT_MS: "15000",
			ASK_JUDGE_MAX_ATTEMPTS: "2",
			ASK_JUDGE_MAX_OUTPUT_TOKENS: "1024",
			VLM_TIMEOUT_MS: "15000",
			VLM_MAX_FIGURES_PER_REQUEST: "2",
			VLM_MAX_IMAGE_BYTES: "5242880",
			EMBEDDING_TIMEOUT_MS: "15000",
			EMBEDDING_BATCH_SIZE: "10",
			RERANK_TIMEOUT_MS: "10000",
		},
		"dbos-worker": {
			CONTEXTUAL_RETRIEVAL_MAX_CHUNKS: "40",
			CONTEXTUAL_RETRIEVAL_TIMEOUT_MS: "1000",
			PARSER_POLL_INTERVAL_MS: "250",
			PARSER_RETRY_BACKOFF_MS: "2000,5000,15000,30000",
		},
		"dbos-control": {
			DBOS_SYSTEM_DATABASE_POOL_SIZE: "10",
			DBOS_CONTROL_POLL_MS: "5000",
			ASK_RUN_MAINTENANCE_ENABLED: "true",
			ASK_RUN_MAINTENANCE_INTERVAL_MS: "900000",
			ASK_RUN_MAINTENANCE_BATCH_SIZE: "1000",
			ASK_RUN_STALE_AFTER_MINUTES: "30",
			ASK_RUN_RETENTION_DAYS: "30",
			TOMBSTONE_MAINTENANCE_ENABLED: "true",
			TOMBSTONE_MAINTENANCE_INTERVAL_MS: "3600000",
			TOMBSTONE_MAINTENANCE_BATCH_SIZE: "100",
			TOMBSTONE_RETENTION_DAYS: "90",
			OBSERVABILITY_CYCLE_ENABLED: "true",
			OBSERVABILITY_CYCLE_INTERVAL_MS: "60000",
			OBSERVABILITY_ASK_MIN_SAMPLES: "10",
			OBSERVABILITY_ASK_FAILURE_RATE_WARNING: "0.05",
			OBSERVABILITY_ASK_CITATION_COVERAGE_MIN: "0.90",
			OBSERVABILITY_ASK_P95_WARNING_MS: "15000",
			OBSERVABILITY_ASK_P95_CRITICAL_MS: "25000",
			OBSERVABILITY_ALERT_RECOVERY_CYCLES: "2",
		},
	};
	const compose = renderComposeConfig();
	for (const [service, values] of Object.entries(defaults)) {
		for (const [name, expected] of Object.entries(values)) {
			assert.equal(advanced.has(name), false, name);
			assert.equal(compose.services[service].environment[name], expected, name);
		}
	}
	const overrides = renderComposeConfig({
		ASK_RUN_MAINTENANCE_BATCH_SIZE: "900",
		PARSER_POLL_INTERVAL_MS: "600",
		EMBEDDING_TIMEOUT_MS: "4500",
		OBSERVABILITY_ASK_P95_WARNING_MS: "17000",
	});
	assert.equal(
		overrides.services["dbos-control"].environment
			.ASK_RUN_MAINTENANCE_BATCH_SIZE,
		"900",
	);
	assert.equal(
		overrides.services["dbos-worker"].environment.PARSER_POLL_INTERVAL_MS,
		"600",
	);
	for (const name of ["web", "dbos-worker"]) {
		assert.equal(
			overrides.services[name].environment.EMBEDDING_TIMEOUT_MS,
			"4500",
		);
	}
	for (const name of ["web", "dbos-control"]) {
		assert.equal(
			overrides.services[name].environment.OBSERVABILITY_ASK_P95_WARNING_MS,
			"17000",
		);
	}
});

test("Compose preserves each provider credential and endpoint pair without flattening aliases", () => {
	const legacy = {
		OPENAI_API_KEY: "test-openai",
		OPENAI_BASE_URL: "https://openai.example/v1",
		DASHSCOPE_API_KEY: "test-dashscope",
		DASHSCOPE_BASE_URL: "https://dashscope.example/v1",
		UNORAG_BASE_URL: "https://console.example",
	};
	for (const overrides of [
		legacy,
		{ ...legacy, LLM_API_KEY: "", LLM_BASE_URL: "" },
		{
			...legacy,
			LLM_API_KEY: "",
			LLM_BASE_URL: "",
			OPENAI_API_KEY: "",
			OPENAI_BASE_URL: "",
		},
	]) {
		const { services } = renderComposeConfig(overrides);
		for (const name of ["web", "dbos-worker", "dbos-control"]) {
			const env = services[name].environment;
			assert.equal(
				env.LLM_API_KEY,
				overrides.LLM_API_KEY ?? "contract-llm-key",
			);
			assert.equal(
				env.LLM_BASE_URL,
				overrides.LLM_BASE_URL ?? "https://models.example/v1",
			);
			assert.equal(env.OPENAI_API_KEY, overrides.OPENAI_API_KEY);
			assert.equal(env.OPENAI_BASE_URL, overrides.OPENAI_BASE_URL);
			assert.equal(env.DASHSCOPE_API_KEY, overrides.DASHSCOPE_API_KEY);
			assert.equal(env.DASHSCOPE_BASE_URL, overrides.DASHSCOPE_BASE_URL);
		}
		assert.equal(
			services.web.environment.UNORAG_BASE_URL,
			legacy.UNORAG_BASE_URL,
		);
	}
});

test("Compose gives control the same Judge and VLM bindings as Web", () => {
	const configured = {
		AI_SUPPORTS_STRUCTURED_OUTPUTS: "false",
		AI_INCLUDE_USAGE: "false",
		JUDGE_MODEL: "independent-judge",
		JUDGE_BASE_URL: "https://judge.example/v1",
		JUDGE_API_KEY: "dedicated-judge-key",
		JUDGE_PROVIDER_NAME: "judge-provider",
		JUDGE_SUPPORTS_STRUCTURED_OUTPUTS: "false",
		VLM_ENABLED: "true",
		VLM_MODEL: "independent-vision",
		VLM_BASE_URL: "https://vision.example/v1",
		VLM_API_KEY: "dedicated-vision-key",
		VLM_PROVIDER_NAME: "vision-provider",
		VLM_TIMEOUT_MS: "24000",
		VLM_MAX_FIGURES_PER_REQUEST: "3",
		VLM_MAX_IMAGE_BYTES: "1048576",
	};
	for (const overrides of [
		{},
		configured,
		{
			...configured,
			JUDGE_API_KEY: "",
			VLM_API_KEY: "",
			VLM_TIMEOUT_MS: "999",
		},
	]) {
		const { services } = renderComposeConfig(overrides);
		for (const key of Object.keys(configured)) {
			const webValue = services.web.environment[key];
			assert.notEqual(webValue, undefined, `Web is missing ${key}`);
			assert.equal(services["dbos-control"].environment[key], webValue, key);
			if (Object.hasOwn(overrides, key))
				assert.equal(webValue, overrides[key], key);
		}
		for (const key of ["JUDGE_API_KEY", "VLM_API_KEY"])
			assert.equal(services["dbos-worker"].environment[key], undefined);
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
		(render.stdout.match(/LLM_BASE_URL/g) ?? []).length,
		3,
		"ConfigMap, DBOS Worker and control must use the same endpoint",
	);
	assert.equal(
		(render.stdout.match(/https:\/\/models\.example\/v1/g) ?? []).length,
		3,
	);
	assert.doesNotMatch(render.stdout, /MINERU_URL/);
	assert.equal((render.stdout.match(/APP_ENV/g) ?? []).length, 3);
	assert.match(render.stdout, /APP_ENV:\s+"production"/);
	const documents = loadAll(render.stdout);
	const worker = documents.find(
		(item) =>
			item?.kind === "StatefulSet" &&
			item.spec?.template?.spec?.containers?.some(
				(container) => container.name === "dbos-worker",
			),
	);
	const workerEnv = worker?.spec.template.spec.containers.find(
		(container) => container.name === "dbos-worker",
	).env;
	assert.equal(
		workerEnv?.find((entry) => entry.name === "CONTEXTUAL_RETRIEVAL_ENABLED")
			?.value,
		"false",
	);
	assert.equal(
		workerEnv?.find((entry) => entry.name === "CONTEXTUAL_RETRIEVAL_MAX_CHUNKS")
			?.value,
		"40",
	);
	assert.equal(
		workerEnv?.find((entry) => entry.name === "CONTEXTUAL_RETRIEVAL_TIMEOUT_MS")
			?.value,
		"1000",
	);
	const configMap = documents.find(
		(item) =>
			item?.kind === "ConfigMap" && item.data?.AI_INCLUDE_USAGE !== undefined,
	);
	assert.equal(configMap?.data.AI_INCLUDE_USAGE, "true");
	assert.equal(configMap?.data.TS_RETRIEVAL_HYBRID_ENABLED, "true");
	assert.equal(configMap?.data.QDRANT_SERVER_HYBRID_ENABLED, undefined);
	assert.equal(configMap?.data.TS_RETRIEVAL_CORPUS_LIMIT, undefined);
	assert.equal(
		workerEnv?.find((entry) => entry.name === "QDRANT_SERVER_HYBRID_ENABLED"),
		undefined,
	);
	const disabled = renderHelm([
		"--set-string",
		"config.aiIncludeUsage=false",
		"--set-string",
		"config.retrievalHybridEnabled=false",
	]);
	assert.equal(disabled.status, 0, disabled.stderr);
	const disabledConfig = loadAll(disabled.stdout).find(
		(item) =>
			item?.kind === "ConfigMap" && item.data?.AI_INCLUDE_USAGE !== undefined,
	);
	assert.equal(disabledConfig?.data.AI_INCLUDE_USAGE, "false");
	assert.equal(disabledConfig?.data.TS_RETRIEVAL_HYBRID_ENABLED, "false");
});

test("Helm binds dedicated model credentials to their matching endpoints", (t) => {
	if (!hasCommand("helm", ["version", "--short"])) {
		t.skip("helm is not installed");
		return;
	}
	const render = renderHelm([
		"--set",
		"config.embeddingBaseUrl=https://embeddings.example/v1",
	]);
	assert.equal(render.status, 0, render.stderr);
	const documents = loadAll(render.stdout).filter(Boolean);
	const config = documents.find((item) => item.kind === "ConfigMap");
	assert.equal(config.data.LLM_BASE_URL, "https://models.example/v1");
	assert.equal(config.data.EMBEDDING_BASE_URL, "https://embeddings.example/v1");
	const workloads = documents.filter((item) =>
		["Deployment", "StatefulSet"].includes(item.kind),
	);
	let checked = 0;
	for (const workload of workloads) {
		for (const container of workload.spec.template.spec.containers) {
			const env = Object.fromEntries(
				(container.env ?? []).map((entry) => [entry.name, entry]),
			);
			if (!["web", "dbos-worker", "dbos-control"].includes(container.name))
				continue;
			checked++;
			assert.equal(env.LLM_API_KEY.valueFrom.secretKeyRef.key, "LLM_API_KEY");
			assert.equal(env.OPENAI_API_KEY, undefined);
			assert.equal(
				env.EMBEDDING_API_KEY.valueFrom.secretKeyRef.key,
				"EMBEDDING_API_KEY",
			);
			if (container.name === "web") {
				for (const key of ["JUDGE_API_KEY", "RERANK_API_KEY"])
					assert.equal(env[key].valueFrom.secretKeyRef.key, key);
			} else {
				assert.equal(env.LLM_BASE_URL.value, config.data.LLM_BASE_URL);
				assert.equal(
					env.EMBEDDING_BASE_URL.value,
					config.data.EMBEDDING_BASE_URL,
				);
			}
		}
	}
	assert.equal(checked, 3);
});

test("Helm gives control the same supported Judge bindings as Web", (t) => {
	if (!hasCommand("helm", ["version", "--short"])) {
		t.skip("helm is not installed");
		return;
	}
	for (const args of [
		[],
		[
			"--set",
			"config.judgeModel=independent-judge",
			"--set",
			"config.judgeBaseUrl=https://judge.example/v1",
			"--set",
			"config.judgeProviderName=judge-provider",
			"--set-string",
			"config.judgeSupportsStructuredOutputs=false",
			"--set-string",
			"config.aiSupportsStructuredOutputs=false",
			"--set-string",
			"config.aiIncludeUsage=false",
		],
	]) {
		const render = renderHelm(args);
		assert.equal(render.status, 0, render.stderr);
		const documents = loadAll(render.stdout).filter(Boolean);
		const config = documents.find((item) => item.kind === "ConfigMap");
		const containers = new Map(
			documents
				.filter((item) => item.kind === "Deployment")
				.flatMap((item) => item.spec.template.spec.containers)
				.map((container) => [container.name, container]),
		);
		const web = containers.get("web");
		const control = containers.get("dbos-control");
		assert.ok(
			web.envFrom.some(
				(entry) => entry.configMapRef?.name === config.metadata.name,
			),
		);
		const webEnv = new Map(web.env.map((entry) => [entry.name, entry]));
		const controlEnv = new Map(control.env.map((entry) => [entry.name, entry]));
		for (const key of [
			"AI_SUPPORTS_STRUCTURED_OUTPUTS",
			"AI_INCLUDE_USAGE",
			"JUDGE_MODEL",
			"JUDGE_BASE_URL",
			"JUDGE_PROVIDER_NAME",
			"JUDGE_SUPPORTS_STRUCTURED_OUTPUTS",
		]) {
			assert.notEqual(config.data[key], undefined, key);
			assert.equal(controlEnv.get(key)?.value, config.data[key], key);
		}
		assert.equal(
			controlEnv.get("JUDGE_API_KEY")?.valueFrom.secretKeyRef.key,
			"JUDGE_API_KEY",
		);
		assert.deepEqual(
			controlEnv.get("JUDGE_API_KEY"),
			webEnv.get("JUDGE_API_KEY"),
		);
	}
});

test("Helm rolls out the same alert defaults to Web and control", (t) => {
	if (!hasCommand("helm", ["version", "--short"])) {
		t.skip("helm is not installed");
		return;
	}
	for (const count of ["10", "27"]) {
		const render = renderHelm([
			"--set-string",
			`observability.nativeAlerts.askMinSamples=${count}`,
		]);
		assert.equal(render.status, 0, render.stderr);
		const documents = loadAll(render.stdout);
		for (const component of ["web", "dbos-control"]) {
			const deployment = documents.find(
				(item) =>
					item?.kind === "Deployment" &&
					item.metadata.labels["app.kubernetes.io/component"] === component,
			);
			const environment = deployment?.spec.template.spec.containers[0].env;
			assert.equal(
				environment?.find(
					(entry) => entry.name === "OBSERVABILITY_ASK_MIN_SAMPLES",
				)?.value,
				count,
			);
		}
	}
});

test("account email secrets reach only Web/control and recipients stay in the application", (t) => {
	const compose = renderComposeConfig({
		EMAIL_PROVIDER: "resend",
		EMAIL_FROM: "ops@example.test",
		RESEND_API_KEY: "contract-email-key",
		APP_BASE_URL: "https://unorag.example",
	});
	for (const name of ["web", "dbos-control"]) {
		assert.equal(compose.services[name].environment.EMAIL_PROVIDER, "resend");
		assert.equal(
			compose.services[name].environment.RESEND_API_KEY,
			"contract-email-key",
		);
	}
	assert.equal(
		compose.services.web.environment.APP_BASE_URL,
		"https://unorag.example",
	);
	assert.equal(
		compose.services["dbos-worker"].environment.RESEND_API_KEY,
		undefined,
	);
	for (const service of Object.values(compose.services)) {
		assert.equal(service.environment?.OBSERVABILITY_ALERT_EMAIL_TO, undefined);
		assert.equal(
			service.environment?.OBSERVABILITY_ALERT_EMAIL_ENABLED,
			undefined,
		);
	}
	if (!hasCommand("helm", ["version", "--short"])) {
		t.skip("helm is not installed");
		return;
	}
	const render = renderHelm([
		"--set",
		"config.emailProvider=resend",
		"--set",
		"config.appBaseUrl=https://unorag.example",
	]);
	assert.equal(render.status, 0, render.stderr);
	const resources = loadAll(render.stdout).filter(Boolean);
	const config = resources.find((item) => item.kind === "ConfigMap");
	assert.equal(config.data.APP_BASE_URL, "https://unorag.example");
	assert.equal(config.data.EMAIL_PROVIDER, "resend");
	assert.equal(config.data.OBSERVABILITY_ALERT_EMAIL_TO, undefined);
	assert.equal(config.data.OBSERVABILITY_ALERT_EMAIL_ENABLED, undefined);
	for (const deployment of resources.filter(
		(item) => item.kind === "Deployment",
	)) {
		const container = deployment.spec.template.spec.containers[0];
		const env = new Map(container.env.map((entry) => [entry.name, entry]));
		const component = deployment.metadata.labels["app.kubernetes.io/component"];
		if (["web", "dbos-control"].includes(component))
			assert.equal(
				env.get("RESEND_API_KEY").valueFrom.secretKeyRef.key,
				"RESEND_API_KEY",
			);
		else assert.equal(env.has("RESEND_API_KEY"), false);
	}
});

test("config reconciliation layers old runtime values without losing custom settings", async (t) => {
	const sandbox = await mkdtemp(join(tmpdir(), "unorag-config-contract-"));
	t.after(() => rm(sandbox, { recursive: true, force: true }));
	const composeDir = join(sandbox, "deploy", "compose");
	const scriptsDir = join(composeDir, "scripts");
	const configDir = join(sandbox, "deploy", "config");
	await mkdir(scriptsDir, { recursive: true });
	await mkdir(configDir, { recursive: true });

	for (const name of [
		"init-config.sh",
		"upgrade.sh",
		"compose-env.sh",
		"release-env.sh",
	]) {
		await cp(
			new URL(`deploy/compose/scripts/${name}`, root),
			join(scriptsDir, name),
		);
	}
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
		advancedPath,
		"ASK_JUDGE_TIMEOUT_MS=24000\nOBSERVABILITY_ASK_MIN_SAMPLES=24\noperator_tag=night-shift\nCUSTOM_MULTILINE='first\nCUSTOM_INNER=second\nthird'\n",
	);
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
	assert.match(advanced, /^ASK_JUDGE_TIMEOUT_MS=24000$/m);
	assert.match(advanced, /^OBSERVABILITY_ASK_MIN_SAMPLES=24$/m);
	assert.match(advanced, /^operator_tag=night-shift$/m);
	assert.match(
		advanced,
		/^CUSTOM_MULTILINE='first\nCUSTOM_INNER=second\nthird'$/m,
	);
	assert.doesNotMatch(advanced, /^MINERU_URL=/m);

	// Stop at queue validation before any Docker or release operation.
	const invalidQueues = advanced.replace(
		/^UNORAG_DBOS_LISTEN_QUEUES=.*$/m,
		"UNORAG_DBOS_LISTEN_QUEUES=invalid",
	);
	await writeFile(
		advancedPath,
		`${invalidQueues}PARSER_POLL_INTERVAL_MS=600\n`,
	);
	const upgrade = spawnSync(
		"bash",
		[join(scriptsDir, "upgrade.sh"), "--from-runtime"],
		{
			cwd: composeDir,
			encoding: "utf8",
		},
	);
	assert.equal(upgrade.status, 1);
	assert.match(
		upgrade.stderr,
		/UNORAG_DBOS_LISTEN_QUEUES must include ingest-local/,
	);
	const upgraded = await readFile(advancedPath, "utf8");
	assert.match(upgraded, /^PARSER_POLL_INTERVAL_MS=600$/m);
	assert.match(upgraded, /^ASK_JUDGE_TIMEOUT_MS=24000$/m);
	assert.match(
		upgraded,
		/^CUSTOM_MULTILINE='first\nCUSTOM_INNER=second\nthird'$/m,
	);

	for (const file of [runtimePath, advancedPath]) await rm(file);
	await writeFile(
		join(composeDir, ".env"),
		"DASHSCOPE_API_KEY=test-legacy-key\nDASHSCOPE_BASE_URL=https://legacy.example/v1\nEMBEDDING_TIMEOUT_MS=7500\nAPP_BASE_URL=https://console.example\n",
	);
	const monolithic = spawnSync("bash", [join(scriptsDir, "init-config.sh")], {
		cwd: composeDir,
		encoding: "utf8",
	});
	assert.equal(monolithic.status, 0, monolithic.stderr);
	assert.match(
		await readFile(runtimePath, "utf8"),
		/^LLM_BASE_URL=https:\/\/legacy.example\/v1$/m,
	);
	assert.match(
		await readFile(join(configDir, "runtime.secret"), "utf8"),
		/^LLM_API_KEY=test-legacy-key$/m,
	);
	const migrated = await readFile(advancedPath, "utf8");
	assert.match(migrated, /^EMBEDDING_TIMEOUT_MS=7500$/m);
	assert.match(migrated, /^APP_BASE_URL=https:\/\/console.example$/m);
});
