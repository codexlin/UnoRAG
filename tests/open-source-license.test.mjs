import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

async function source(path) {
	return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

for (const scenario of [
	{
		name: "packaged license",
		license: "LicenseRef-Custom",
		text: "Fixture copyright and license text",
		expected: "Fixture copyright and license text",
	},
	{
		name: "canonical SPDX fallback",
		license: "MIT",
		expected: "Permission is hereby granted",
	},
	{
		name: "unknown license without text",
		license: "LicenseRef-Unknown",
		failure: true,
	},
]) {
	test(`notice generation preserves ${scenario.name} without an auxiliary dependency scanner`, async () => {
		const directory = await mkdtemp(
			path.join(os.tmpdir(), "unorag-notice-test-"),
		);
		try {
			const bin = path.join(directory, "bin");
			const pkg = path.join(directory, "package");
			const output = path.join(directory, "notices.txt");
			await mkdir(bin);
			await mkdir(pkg);
			if (scenario.text)
				await writeFile(path.join(pkg, "LICENSE"), scenario.text);
			const inventory = {
				[scenario.license]: [
					{
						name: "fixture-package",
						versions: ["1.0.0"],
						paths: [pkg],
						author: "Fixture",
						homepage: "https://example.test",
					},
				],
			};
			await writeFile(
				path.join(bin, "pnpm"),
				`#!/bin/sh\nif [ "$*" != "licenses list --prod --json" ]; then exit 99; fi\nprintf '%s' "$FIXTURE_LICENSE_INVENTORY"\n`,
			);
			await chmod(path.join(bin, "pnpm"), 0o755);
			const run = spawnSync(
				process.execPath,
				[
					fileURLToPath(
						new URL(
							"../scripts/generate-third-party-notices.mjs",
							import.meta.url,
						),
					),
					output,
				],
				{
					env: {
						...process.env,
						PATH: `${bin}:${process.env.PATH}`,
						FIXTURE_LICENSE_INVENTORY: JSON.stringify(inventory),
					},
					encoding: "utf8",
					timeout: 10_000,
				},
			);
			if (scenario.failure) {
				assert.notEqual(run.status, 0);
				assert.match(
					run.stderr,
					/No distributable license text found for fixture-package@1.0.0/,
				);
			} else {
				assert.equal(run.status, 0, run.stderr);
				const bundle = await readFile(output, "utf8");
				assert.ok(bundle.includes(scenario.expected));
				assert.ok(
					bundle.includes(`fixture-package@1.0.0 [${scenario.license}]`),
				);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}

test("repository metadata consistently activates Apache-2.0", async () => {
	const [license, notice, packageJson, readme, readmeZh, contributing] =
		await Promise.all([
			source("LICENSE"),
			source("NOTICE"),
			source("package.json"),
			source("README.md"),
			source("README.zh-CN.md"),
			source("CONTRIBUTING.md"),
		]);

	assert.match(license, /Apache License\s+Version 2\.0, January 2004/);
	assert.match(notice, /Copyright 2026 UnoRAG contributors/);
	assert.equal(JSON.parse(packageJson).license, "Apache-2.0");
	assert.match(readme, /licensed under \[Apache License 2\.0\]/);
	assert.match(readmeZh, /采用 \[Apache License 2\.0\]/);
	assert.match(contributing, /provided under Apache-2\.0/);

	for (const document of [readme, readmeZh, contributing]) {
		assert.doesNotMatch(
			document,
			/candidate license|候选许可证|once it is adopted/,
		);
	}
});

test("trademark policy remains separate from the source-code license", async () => {
	const [policy, notice, readme, readmeZh, docsIndex] = await Promise.all([
		source("TRADEMARKS.md"),
		source("NOTICE"),
		source("README.md"),
		source("README.zh-CN.md"),
		source("docs/README.md"),
	]);

	assert.match(policy, /The Apache License 2\.0 grants broad rights/);
	assert.match(policy, /Forks and modified distributions/);
	assert.match(policy, /Hosted services/);
	assert.match(policy, /screenshots or short screen recordings/);
	assert.match(policy, /UnoRAG Knowledge API/);
	assert.match(policy, /UnoRAG 商标使用政策/);
	assert.match(notice, /not licensed under Apache License 2\.0/);
	assert.match(readme, /\[trademark policy\]\(\.\/TRADEMARKS\.md\)/);
	assert.match(readmeZh, /\[商标使用政策\]\(\.\/TRADEMARKS\.md\)/);
	assert.match(docsIndex, /\[TRADEMARKS\.md\]\(\.\.\/TRADEMARKS\.md\)/);
});

test("release workflow publishes GHCR without requiring an ACR mirror", async () => {
	const workflow = await source(".github/workflows/release-images.yml");
	assert.match(workflow, /ghcr_repo="ghcr\.io\/\$\{owner\}\/unorag"/);
	assert.match(workflow, /mirror_acr:/);
	assert.match(workflow, /INPUT_MIRROR_ACR/);
	assert.match(workflow, /publish_acr=false/);
	assert.match(workflow, /if: steps\.meta\.outputs\.publish_acr == 'true'/);
	assert.match(workflow, /Mirror runtime manifests to ACR/);
	assert.match(workflow, /ACR_WEB_DIGEST/);
	assert.match(workflow, /ACR_TRANSFER_TIMEOUT: 15m/);
	assert.doesNotMatch(workflow, /ACR_USERNAME secret is required/);
});

test("release assets and fixtures have a hash-bound provenance gate", async () => {
	const [assets, manifest, checker, packageJson, workflow] = await Promise.all([
		source("ASSETS.md"),
		source("assets/provenance.json"),
		source("scripts/check-asset-provenance.mjs"),
		source("package.json"),
		source(".github/workflows/ci.yml"),
	]);

	const parsed = JSON.parse(manifest);
	assert.equal(parsed.schema_version, 1);
	assert.ok(parsed.groups.length >= 4);
	assert.match(assets, /synthetic material authored or generated/);
	assert.match(checker, /Provenance hash mismatch/);
	const scripts = JSON.parse(packageJson).scripts;
	assert.equal(
		scripts["assets:check"],
		"node scripts/check-asset-provenance.mjs",
	);
	assert.match(scripts.verify, /pnpm assets:check/);
	assert.match(workflow, /run: pnpm verify/);
});

test("all release image families carry generated production dependency notices", async () => {
	const [generator, dockerfile, packageJson, workflow] = await Promise.all([
		source("scripts/generate-third-party-notices.mjs"),
		source("deploy/docker/web.Dockerfile"),
		source("package.json"),
		source(".github/workflows/ci.yml"),
	]);

	assert.match(generator, /licenses", "list", "--prod", "--json"/);
	assert.match(generator, /No distributable license text found/);
	assert.match(
		dockerfile,
		/FROM node:22-bookworm-slim AS runtime-deps[\s\S]*THIRD_PARTY_NOTICES\.txt/,
	);
	assert.match(
		dockerfile,
		/FROM node:22-bookworm-slim AS migrator[\s\S]*THIRD_PARTY_NOTICES\.txt/,
	);
	assert.match(
		dockerfile,
		/FROM node:22-bookworm-slim AS runner[\s\S]*THIRD_PARTY_NOTICES\.txt/,
	);
	const scripts = JSON.parse(packageJson).scripts;
	assert.equal(
		scripts["notices:check"],
		"node scripts/generate-third-party-notices.mjs",
	);
	assert.match(scripts.verify, /pnpm notices:check/);
	assert.match(workflow, /run: pnpm verify/);
});
