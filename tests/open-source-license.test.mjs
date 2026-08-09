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
	assert.doesNotMatch(workflow, /ACR_USERNAME secret is required/);
});
