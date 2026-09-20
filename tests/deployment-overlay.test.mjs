import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();

test("Apple Silicon overlay emulates product images without pinning infrastructure", async () => {
	const overlay = await readFile(
		path.join(root, "deploy/compose/docker-compose.local-amd64.yml"),
		"utf8",
	);
	const pinnedServices = [
		...overlay.matchAll(/^ {2}([a-z0-9-]+):\n {4}platform: linux\/amd64$/gm),
	]
		.map((match) => match[1])
		.sort();

	assert.deepEqual(pinnedServices, [
		"backfill-acl-projections",
		"bootstrap",
		"check-dbos-drain",
		"dbos-control",
		"dbos-worker",
		"document-storage-init",
		"inspect-lifecycle",
		"migrate-web",
		"web",
	]);
	for (const service of [
		"caddy",
		"postgres",
		"configure-db-roles",
		"qdrant",
		"redis",
	]) {
		assert.doesNotMatch(overlay, new RegExp(`^  ${service}:`, "m"));
	}
});

test("Compose maintenance commands reuse the persisted deployment overlay", async () => {
	const temp = await mkdtemp(path.join(tmpdir(), "unorag-overlay-"));
	const compose = path.join(temp, "deploy", "compose");
	const config = path.join(temp, "deploy", "config");
	const bin = path.join(temp, "bin");
	await Promise.all([
		mkdir(path.join(compose, "scripts"), { recursive: true }),
		mkdir(config, { recursive: true }),
		mkdir(bin, { recursive: true }),
	]);
	await writeFile(
		path.join(compose, "scripts", "compose-env.sh"),
		await readFile(
			path.join(root, "deploy/compose/scripts/compose-env.sh"),
			"utf8",
		),
	);
	await writeFile(path.join(compose, "docker-compose.yml"), "services: {}\n");
	await writeFile(
		path.join(compose, "docker-compose.public.yml"),
		"services: {}\n",
	);
	await writeFile(
		path.join(config, "runtime.env"),
		"UNORAG_COMPOSE_OVERLAY=./docker-compose.public.yml\n",
	);
	await writeFile(
		path.join(config, "runtime.advanced.env"),
		"PLACEHOLDER=value\n",
	);
	await writeFile(path.join(config, "runtime.secret"), "PLACEHOLDER=value\n");
	await writeFile(
		path.join(bin, "docker"),
		"#!/bin/sh\nprintf '%s\\n' \"$@\"\n",
		{ mode: 0o755 },
	);

	const { stdout } = await execFileAsync(
		"bash",
		[
			"-c",
			`source '${path.join(compose, "scripts", "compose-env.sh")}'; mk_compose config`,
		],
		{ env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
	);
	const args = stdout.trim().split("\n");
	assert.ok(args.includes(path.join(compose, "docker-compose.public.yml")));
});
