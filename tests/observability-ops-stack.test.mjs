import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

test("Compose Ops Stack is opt-in, private, bounded, and credential-safe", () => {
	const base = read("deploy/compose/docker-compose.yml");
	const ops = read("deploy/compose/docker-compose.observability.yml");

	for (const service of [
		"otel-collector",
		"prometheus",
		"alertmanager",
		"tempo",
		"loki",
		"grafana",
	]) {
		assert.match(ops, new RegExp(`^  ${service}:`, "m"));
	}
	assert.doesNotMatch(
		base,
		/^ {2}(otel-collector|prometheus|tempo|loki|grafana):/m,
	);
	assert.match(ops, /profiles: \["observability"\]/);
	assert.match(ops, /"127\.0\.0\.1:\$\{GRAFANA_PORT:-3300\}:3000"/);
	assert.match(
		ops,
		/^ {2}telemetry-ingest:\n {4}driver: bridge\n {4}internal: true$/m,
	);
	assert.match(
		ops,
		/^ {2}observability-backend:\n {4}driver: bridge\n {4}internal: true$/m,
	);
	assert.match(ops, /^ {2}grafana-access:\n {4}driver: bridge$/m);
	const webBlock = ops.match(/^ {2}web:[\s\S]*?(?=^ {2}\S|Z)/m)?.[0] ?? "";
	assert.match(webBlock, /telemetry-ingest/);
	assert.doesNotMatch(webBlock, /observability-backend/);
	assert.doesNotMatch(
		ops,
		/(DATABASE_URL|POSTGRES_PASSWORD|QDRANT_API_KEY|LLM_API_KEY):/,
	);
	assert.match(ops, /mem_limit:/);
	assert.match(ops, /cap_drop: \["ALL"\]/);
	assert.match(ops, /loki-storage-init:[\s\S]*cap_add: \["CHOWN"\]/);
});

test("edge blocks product metrics while Prometheus scrapes them internally", () => {
	for (const file of [
		"deploy/compose/Caddyfile",
		"deploy/compose/Caddyfile.webch.cn",
	]) {
		const caddy = read(file);
		assert.match(caddy, /@internalMetrics path \/metrics \/api\/metrics/);
		assert.match(caddy, /respond @internalMetrics 404/);
	}
	assert.match(
		read("deploy/compose/observability/otel-collector.yaml"),
		/metrics_path: \/metrics[\s\S]*targets: \[web:3000\]/,
	);
	assert.match(
		read("deploy/compose/observability/prometheus.yaml"),
		/targets: \[otel-collector:9464\]/,
	);
});

test("Grafana provisions five focused dashboards backed by real signal contracts", () => {
	const directory = path.join(
		root,
		"deploy/compose/observability/grafana/dashboards",
	);
	const files = readdirSync(directory).filter((file) => file.endsWith(".json"));
	assert.equal(files.length, 5);
	const dashboards = files.map((file) =>
		JSON.parse(readFileSync(path.join(directory, file), "utf8")),
	);
	assert.deepEqual(
		new Set(dashboards.map((dashboard) => dashboard.uid)),
		new Set([
			"unorag-operations",
			"unorag-rag-quality",
			"unorag-ingestion-parser",
			"unorag-lifecycle-dbos",
			"unorag-infrastructure",
		]),
	);
	const serialized = JSON.stringify(dashboards);
	for (const signal of [
		"unorag_ask_completions_total",
		"parser.provider.attempt",
		"dbos.control.tick",
		"otelcol_receiver_accepted_spans_total",
	]) {
		assert.match(serialized, new RegExp(signal.replaceAll(".", "\\.")));
	}
	for (const forbidden of [
		'"question"',
		'"answer"',
		'"prompt"',
		"document_id",
	]) {
		assert.equal(serialized.toLowerCase().includes(forbidden), false);
	}
	const logger = read("src/lib/observability/logger.ts");
	for (const projectedField of [
		"parserprovider",
		"parseroperation",
		"querytype",
		"retrievalmode",
		"citationcount",
		"errorcode",
		"httpstatus",
		"retrydelayms",
	]) {
		assert.match(logger, new RegExp(`"${projectedField}"`));
	}
});

test("Collector strips sensitive content and exports only traces and logs", () => {
	const collector = read("deploy/compose/observability/otel-collector.yaml");
	for (const key of [
		"http.request.header.authorization",
		"http.request.header.cookie",
		"gen_ai.prompt",
		"gen_ai.completion",
		"db.statement",
		"gen_ai.input.messages",
		"gen_ai.output.messages",
		"ai.prompt",
		"ai.prompt.messages",
		"ai.response.text",
		"ai.response.object",
		"ai.toolCall.args",
		"ai.toolCall.result",
		"ai.embedding",
		"ai.embeddings",
		"langfuse.observation.input",
		"langfuse.observation.output",
	]) {
		assert.match(collector, new RegExp(`key: ${key.replaceAll(".", "\\.")}`));
	}
	for (const key of [
		"process.command",
		"process.command_args",
		"process.command_line",
		"process.executable.path",
		"process.owner",
		"host.name",
	]) {
		assert.match(collector, new RegExp(`key: ${key.replaceAll(".", "\\.")}`));
	}
	assert.match(
		collector,
		/processors: \[memory_limiter, resource\/privacy, attributes\/privacy, batch\]/,
	);
	assert.match(
		collector,
		/readers:[\s\S]*pull:[\s\S]*prometheus:[\s\S]*host: 0\.0\.0\.0[\s\S]*port: 8888/,
	);
	assert.doesNotMatch(collector, /^ {4}metrics:\n {6}receivers: \[otlp\]/m);
});

test("Langfuse is a Collector-only metadata trace fan-out", () => {
	const overlay = read("deploy/compose/docker-compose.langfuse.yml");
	const collector = read(
		"deploy/compose/observability/otel-collector.langfuse.yaml",
	);
	assert.match(overlay, /^ {2}otel-collector:/m);
	assert.doesNotMatch(overlay, /^ {2}(web|dbos-worker|dbos-control):/m);
	assert.match(overlay, /LANGFUSE_OTLP_AUTHORIZATION/);
	assert.match(collector, /otlphttp\/langfuse:/);
	assert.match(collector, /x-langfuse-ingestion-version: "4"/);
	assert.match(collector, /exporters: \[otlphttp\/tempo, otlphttp\/langfuse\]/);
	assert.doesNotMatch(collector, /logs:[\s\S]*otlphttp\/langfuse/);
});

test("install and upgrade preserve the explicit observability mode", () => {
	const install = read("deploy/compose/scripts/install.sh");
	const upgrade = read("deploy/compose/scripts/upgrade.sh");
	for (const script of [install, upgrade]) {
		assert.match(script, /--with-ops\|--with-observability/);
		assert.match(script, /mk_compose_observability/);
		assert.match(script, /observability-smoke\.sh/);
		assert.match(script, /--with-langfuse/);
		assert.match(script, /mk_compose_langfuse/);
	}
	assert.match(upgrade, /existing_langfuse_enabled/);
	assert.match(
		upgrade,
		/runtime_compose up -d --wait dbos-worker dbos-control/,
	);
	assert.match(upgrade, /runtime_compose up -d --no-deps --wait web/);
});

test("observability smoke uses backend-specific probes and a real metrics query", () => {
	const smoke = read("deploy/compose/scripts/observability-smoke.sh");
	assert.match(smoke, /uid in prometheus loki/);
	assert.doesNotMatch(smoke, /uid in prometheus tempo loki/);
	assert.match(smoke, /proxy\/uid\/tempo\/api\/status\/buildinfo/);
	assert.match(smoke, /up\{job="otel-collector"\}/);
	assert.match(smoke, /Prometheus has no otel-collector target sample/);
});

test("Helm exposes fail-closed external OTLP integration", (t) => {
	const helm = spawnSync("helm", ["version", "--short"], { encoding: "utf8" });
	if (helm.status !== 0) {
		t.skip("helm is not installed");
		return;
	}
	const chart = path.join(root, "deploy/helm/unorag");
	const baseArgs = [
		"template",
		"unorag",
		chart,
		"--set",
		"config.openaiBaseUrl=http://model.invalid/v1",
	];
	const disabled = spawnSync("helm", baseArgs, { encoding: "utf8" });
	assert.equal(disabled.status, 0, disabled.stderr);
	assert.match(disabled.stdout, /name: OTEL_SDK_DISABLED\n\s+value: "true"/);
	assert.match(
		disabled.stdout,
		/name: METRICS_INTERNAL_ENABLED\n\s+value: "false"/,
	);

	const enabled = spawnSync(
		"helm",
		[
			...baseArgs,
			"--set",
			"observability.otel.enabled=true",
			"--set",
			"observability.otel.endpoint=http://collector.monitoring:4318",
		],
		{ encoding: "utf8" },
	);
	assert.equal(enabled.status, 0, enabled.stderr);
	assert.equal(
		(enabled.stdout.match(/name: OTEL_SERVICE_NAME/g) ?? []).length,
		3,
	);
	assert.match(enabled.stdout, /value: "http:\/\/collector\.monitoring:4318"/);
	assert.doesNotMatch(enabled.stdout, /(grafana\/|grafana:|prom\/prometheus)/);

	const invalid = spawnSync(
		"helm",
		[...baseArgs, "--set", "observability.otel.enabled=true"],
		{ encoding: "utf8" },
	);
	assert.notEqual(invalid.status, 0);
	assert.match(invalid.stderr, /requires observability\.otel\.endpoint/);
});
