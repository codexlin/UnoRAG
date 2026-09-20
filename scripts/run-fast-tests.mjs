import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { integrationTestFiles } from "./test-suites.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const integrationFiles = new Set(integrationTestFiles);

async function testFiles(directory, extension) {
	const entries = await readdir(path.join(root, directory), {
		withFileTypes: true,
	});
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(extension))
		.map((entry) => path.posix.join(directory, entry.name))
		.filter((file) => !integrationFiles.has(file))
		.sort();
}

function run(args) {
	const result = spawnSync(process.execPath, args, {
		cwd: root,
		stdio: "inherit",
		env: process.env,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

const rootTests = await testFiles("tests", ".test.mjs");
const coreTests = await testFiles("tests/ts-core", ".test.ts");

run(["--test", ...rootTests]);
run(["--import", "tsx", "--test", "--test-concurrency=1", ...coreTests]);
