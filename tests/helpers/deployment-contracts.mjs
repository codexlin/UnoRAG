import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

export const repositoryRoot = new URL("../../", import.meta.url);

function deploymentCommandEnvironment(overrides) {
	const inheritedNames = [
		"PATH",
		"HOME",
		"TMPDIR",
		"XDG_CONFIG_HOME",
		"DOCKER_CONFIG",
		"DOCKER_CONTEXT",
		"DOCKER_HOST",
		"DOCKER_CERT_PATH",
		"DOCKER_TLS_VERIFY",
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"NO_PROXY",
	];
	const inherited = Object.fromEntries(
		inheritedNames.flatMap((name) =>
			process.env[name] === undefined ? [] : [[name, process.env[name]]],
		),
	);
	return {
		...inherited,
		POSTGRES_PASSWORD: "contract-postgres",
		UNORAG_WEB_DB_PASSWORD: "contract-web",
		UNORAG_WORKER_DB_PASSWORD: "contract-worker",
		UNORAG_SESSION_SECRET: "contract-session-secret-0000000000000000",
		LLM_API_KEY: "contract-llm-key",
		LLM_BASE_URL: "https://models.example/v1",
		QDRANT_URL: "http://qdrant:6333",
		REDIS_URL: "redis://redis:6379",
		EMBEDDING_MODEL: "contract-embedding",
		EMBEDDING_DIM: "1024",
		...overrides,
	};
}

export function renderComposeConfig(overrides = {}) {
	const result = spawnSync(
		"docker",
		[
			"compose",
			"--env-file",
			new URL("deploy/config/runtime.env.example", repositoryRoot).pathname,
			"--env-file",
			new URL("deploy/config/runtime.advanced.env.example", repositoryRoot)
				.pathname,
			"-f",
			new URL("deploy/compose/docker-compose.yml", repositoryRoot).pathname,
			"config",
			"--format",
			"json",
		],
		{
			cwd: new URL("deploy/compose/", repositoryRoot).pathname,
			encoding: "utf8",
			env: deploymentCommandEnvironment(overrides),
		},
	);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return JSON.parse(result.stdout);
}

export function renderHelm(args = []) {
	return spawnSync(
		"helm",
		[
			"template",
			"unorag",
			new URL("deploy/helm/unorag", repositoryRoot).pathname,
			"--set",
			"config.llmBaseUrl=https://models.example/v1",
			...args,
		],
		{ encoding: "utf8" },
	);
}

export function hasCommand(command, args = ["--version"]) {
	return spawnSync(command, args, { encoding: "utf8" }).status === 0;
}
