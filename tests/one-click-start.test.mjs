import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	access,
	chmod,
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

test("one-click startup preserves the production install boundary", async () => {
	const scriptUrl = new URL("start.sh", root);
	await access(scriptUrl);
	const script = await readFile(scriptUrl, "utf8");

	assert.match(script, /docker compose version/);
	assert.match(script, /docker info/);
	assert.match(script, /scripts\/init-config\.sh/);
	assert.match(script, /OpenAI-compatible model API key/);
	assert.match(
		script,
		/ensure_random_secret "\$RUNTIME_SECRET" POSTGRES_PASSWORD/,
	);
	assert.match(
		script,
		/ensure_random_secret "\$RUNTIME_SECRET" UNORAG_SESSION_SECRET/,
	);
	assert.match(script, /\.\/scripts\/install\.sh/);
	assert.match(script, /scripts\/rotate-admin-password\.sh/);
	assert.match(script, /--manifest/);
	assert.match(script, /first run default: 8080/);
	assert.doesNotMatch(script, /LLM_API_KEY=[A-Za-z0-9_-]{12,}/);
});

test("public docs distinguish one-click local use from manifest production installs", async () => {
	const [english, chinese, deployment] = await Promise.all([
		readFile(new URL("README.md", root), "utf8"),
		readFile(new URL("README.zh-CN.md", root), "utf8"),
		readFile(new URL("docs/DEPLOYMENT.md", root), "utf8"),
	]);

	for (const source of [english, chinese, deployment]) {
		assert.match(source, /\.\/start\.sh/);
		assert.match(source, /LLM_API_KEY/);
	}
	assert.match(deployment, /本地体验/);
	assert.match(deployment, /不属于正式客户交付/);
	assert.match(english, /install\.sh --manifest/);
	assert.match(chinese, /install\.sh --manifest/);
});

test("one-click startup initializes secrets and rotates an explicit password on rerun", async (t) => {
	const sandbox = await mkdtemp(join(tmpdir(), "unorag-start-"));
	t.after(() => rm(sandbox, { recursive: true, force: true }));

	const scripts = join(sandbox, "deploy", "compose", "scripts");
	const mockBin = join(sandbox, "bin");
	await mkdir(scripts, { recursive: true });
	await mkdir(mockBin, { recursive: true });
	await writeFile(
		join(sandbox, "start.sh"),
		await readFile(new URL("start.sh", root)),
	);
	await chmod(join(sandbox, "start.sh"), 0o755);

	await writeExecutable(
		join(mockBin, "docker"),
		'#!/usr/bin/env bash\n[[ "$1 $2" == "compose version" || "$1" == "info" ]]\n',
	);
	await writeExecutable(
		join(scripts, "init-config.sh"),
		`#!/usr/bin/env bash
set -euo pipefail
mkdir -p "${sandbox}/deploy/config"
for file in runtime.env runtime.secret bootstrap.env; do
	[[ -f "${sandbox}/deploy/config/$file" ]] || : >"${sandbox}/deploy/config/$file"
done
`,
	);
	await writeExecutable(
		join(scripts, "install.sh"),
		`#!/usr/bin/env bash
printf '%s\\n' "$*" >"${sandbox}/install.args"
`,
	);
	await writeExecutable(
		join(scripts, "rotate-admin-password.sh"),
		`#!/usr/bin/env bash
: >"${sandbox}/password.rotated"
`,
	);

	const first = runSandboxStart(sandbox, {
		LLM_API_KEY: "test-model-key",
		UNORAG_COMPOSE_PROJECT_NAME: "unorag_test",
	});
	assert.equal(first.status, 0, first.stderr || first.stdout);
	const runtime = await readFile(
		join(sandbox, "deploy", "config", "runtime.env"),
		"utf8",
	);
	const secrets = await readFile(
		join(sandbox, "deploy", "config", "runtime.secret"),
		"utf8",
	);
	const bootstrap = await readFile(
		join(sandbox, "deploy", "config", "bootstrap.env"),
		"utf8",
	);
	assert.match(runtime, /^HTTP_PORT=8080$/m);
	assert.match(runtime, /^COMPOSE_PROJECT_NAME=unorag_test$/m);
	assert.match(secrets, /^LLM_API_KEY=test-model-key$/m);
	assert.match(secrets, /^POSTGRES_PASSWORD=[a-f0-9]{64}$/m);
	assert.match(secrets, /^UNORAG_SESSION_SECRET=[a-f0-9]{64}$/m);
	assert.match(bootstrap, /^UNORAG_ADMIN_PASSWORD=[a-f0-9]{64}$/m);
	assert.doesNotMatch(first.stdout, /test-model-key/);

	const second = runSandboxStart(sandbox, {
		LLM_API_KEY: "test-model-key",
		UNORAG_ADMIN_PASSWORD: "chosen-admin-password",
	});
	assert.equal(second.status, 0, second.stderr || second.stdout);
	assert.match(
		await readFile(join(sandbox, "deploy", "config", "bootstrap.env"), "utf8"),
		/^UNORAG_ADMIN_PASSWORD=chosen-admin-password$/m,
	);
	await access(join(sandbox, "password.rotated"));
});

async function writeExecutable(path, contents) {
	await writeFile(path, contents);
	await chmod(path, 0o755);
}

function runSandboxStart(sandbox, extraEnv) {
	return spawnSync("bash", [join(sandbox, "start.sh"), "--no-open"], {
		cwd: sandbox,
		encoding: "utf8",
		env: {
			...process.env,
			...extraEnv,
			PATH: `${join(sandbox, "bin")}:/usr/bin:/bin`,
		},
	});
}
