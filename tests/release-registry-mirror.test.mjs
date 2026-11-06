import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import yaml from "js-yaml";

const workflow = yaml.load(
	await readFile(
		new URL("../.github/workflows/release-images.yml", import.meta.url),
		"utf8",
	),
);
const mirror = workflow.jobs["build-and-maybe-push"].steps.find(
	(step) => step.id === "acr",
);
const digest = `sha256:${"a".repeat(64)}`;

async function executeMirror(t, settings = {}) {
	const directory = await mkdtemp(join(tmpdir(), "unorag-registry-mirror-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const calls = join(directory, "calls.jsonl");
	const output = join(directory, "outputs");
	await writeFile(output, "");
	const driver = `#!${process.execPath}
const fs = require('node:fs');
const {basename} = require('node:path');
const {spawnSync} = require('node:child_process');
const command = basename(process.argv[1]), args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({command,args})+'\\n');
if(command==='timeout') {
 if(args[0]!=='--foreground'||args[1]!=='15m')process.exit(98);
 if(process.env.FAIL_OPERATION==='timeout'&&args[3]==='push'){
  console.error('fixture transfer exceeded budget'); process.exit(124);
 }
 const child=spawnSync(args[2],args.slice(3),{env:process.env,stdio:'inherit'});
 process.exit(child.status??99);
}
const operation=args[0], ref=args.at(-1);
if(operation===process.env.FAIL_OPERATION&&ref.includes(':'+process.env.FAIL_TARGET+'-')){
 console.error('fixture registry denied requested access');
 if(process.env.LEAK_FIXTURE==='1')console.error(process.env.ACR_USERNAME+' '+process.env.ACR_PASSWORD+' ::error::untrusted registry text');
 process.exit(Number(process.env.FAIL_CODE));
}
if(operation==='push'){
 console.log('fixture pushed layers');
 console.log(process.env.MISSING_DIGEST==='1'?'no digest returned':'tag: digest: ${digest} size: 1234');
}
`;
	await writeFile(join(directory, "docker"), driver, { mode: 0o700 });
	await writeFile(join(directory, "timeout"), driver, { mode: 0o700 });
	const result = spawnSync(
		"bash",
		["--noprofile", "--norc", "-eo", "pipefail", "-c", mirror.run],
		{
			encoding: "utf8",
			timeout: 10_000,
			env: {
				PATH: `${directory}:${process.env.PATH}`,
				TAG: "v0.0.0-fixture",
				IMAGE_PLATFORM: "linux/amd64",
				GHCR_REPO: "ghcr.io/fixture/unorag",
				ACR_REPO: "registry.example/fixture/unorag",
				ACR_TRANSFER_TIMEOUT: "15m",
				GITHUB_OUTPUT: output,
				CALL_LOG: calls,
				FAIL_OPERATION: "",
				FAIL_TARGET: "web",
				FAIL_CODE: "17",
				...settings,
			},
		},
	);
	assert.equal(result.error, undefined);
	return {
		...result,
		calls: (await readFile(calls, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line)),
		outputs: await readFile(output, "utf8"),
		log: `${result.stdout}${result.stderr}`,
	};
}

test("mirror executes the workflow step and records four complete digest outputs", async (t) => {
	const result = await executeMirror(t);
	assert.equal(result.status, 0, result.log);
	assert.deepEqual(
		result.outputs.trim().split("\n"),
		["web", "migrator", "ops", "worker"].map(
			(target) => `${target}_digest=${digest}`,
		),
	);
	assert.equal(
		result.calls.filter((call) => call.command === "timeout").length,
		8,
	);
	assert.equal(
		result.calls.filter(
			(call) => call.command === "docker" && call.args[0] === "push",
		).length,
		4,
	);
});

for (const target of ["web", "migrator"]) {
	test(`failed ${target} push logs the cause and retains exit 17 without continuing`, async (t) => {
		const result = await executeMirror(t, {
			FAIL_OPERATION: "push",
			FAIL_TARGET: target,
		});
		assert.equal(result.status, 17, result.log);
		assert.match(result.log, /fixture registry denied requested access/);
		assert.match(result.log, new RegExp(`ACR push failed for ${target}.*17`));
		assert.equal(
			result.outputs,
			target === "web" ? "" : `web_digest=${digest}\n`,
		);
		assert.equal(
			result.calls.at(-1).args.at(-1),
			`registry.example/fixture/unorag:${target}-v0.0.0-fixture`,
		);
	});
}

test("push timeout retains exit 124 and its diagnostic instead of producing a digest", async (t) => {
	const result = await executeMirror(t, { FAIL_OPERATION: "timeout" });
	assert.equal(result.status, 124, result.log);
	assert.match(result.log, /fixture transfer exceeded budget/);
	assert.equal(result.outputs, "");
});

for (const operation of ["pull", "tag"]) {
	test(`${operation} failure stops before pushing or recording any digest`, async (t) => {
		const result = await executeMirror(t, {
			FAIL_OPERATION: operation,
			FAIL_CODE: "23",
		});
		assert.equal(result.status, 23, result.log);
		assert.equal(result.outputs, "");
		assert.equal(
			result.calls.some(
				(call) => call.command === "docker" && call.args[0] === "push",
			),
			false,
		);
	});
}

test("successful push without a digest fails closed", async (t) => {
	const result = await executeMirror(t, { MISSING_DIGEST: "1" });
	assert.equal(result.status, 1, result.log);
	assert.match(result.log, /missing ACR digest for web/);
	assert.equal(result.outputs, "");
});

test("push diagnostic redacts literal credentials and cannot inject Actions commands", async (t) => {
	const username = "fixture-registry-user";
	const password = "fixture-[pw]*?/%-literal";
	const result = await executeMirror(t, {
		FAIL_OPERATION: "push",
		LEAK_FIXTURE: "1",
		ACR_USERNAME: username,
		ACR_PASSWORD: password,
	});
	assert.equal(result.status, 17, result.log);
	assert.equal(result.log.includes(username), false);
	assert.equal(result.log.includes(password), false);
	assert.match(result.log, /\[redacted\]/);
	assert.equal(result.log.includes("::error::"), false);
	assert.match(result.log, /untrusted registry text/);
});
