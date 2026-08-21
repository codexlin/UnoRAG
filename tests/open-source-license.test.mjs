import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
	return readFile(new URL(`../${path}`, import.meta.url), "utf8");
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

test("release workflow publishes GHCR without requiring an ACR mirror", async () => {
	const workflow = await source(".github/workflows/release-images.yml");
	assert.match(workflow, /ghcr_repo="ghcr\.io\/\$\{owner\}\/unorag"/);
	assert.match(workflow, /publish_acr=false/);
	assert.match(workflow, /if: steps\.meta\.outputs\.publish_acr == 'true'/);
	assert.match(workflow, /Mirror runtime manifests to ACR/);
	assert.match(workflow, /ACR_WEB_DIGEST/);
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
	assert.equal(
		JSON.parse(packageJson).scripts["assets:check"],
		"node scripts/check-asset-provenance.mjs",
	);
	assert.match(workflow, /pnpm assets:check/);
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
	assert.equal(
		JSON.parse(packageJson).scripts["notices:check"],
		"node scripts/generate-third-party-notices.mjs",
	);
	assert.match(workflow, /pnpm notices:check/);
});
