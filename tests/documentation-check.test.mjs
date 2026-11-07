import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(
	new URL("../scripts/check-docs.mjs", import.meta.url),
);

function fixture(t) {
	const root = mkdtempSync(path.join(os.tmpdir(), "unorag-docs-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	execFileSync("git", ["init", "--quiet", root]);
	function write(file, content) {
		const target = path.join(root, file);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	write("README.md", "[Evidence](./docs/evidence/README.md)\n");
	write("docs/evidence/2026-01-01-release.md", "# Current release\n");
	write(
		"docs/evidence/README.md",
		"[Current](./2026-01-01-release.md)\n[History](https://example.org/history)\n",
	);
	function run() {
		const result = spawnSync(process.execPath, [checker], {
			cwd: root,
			encoding: "utf8",
		});
		return { status: result.status, output: result.stdout + result.stderr };
	}
	return { root, write, run };
}

test("documentation checks include new untracked files before staging", (t) => {
	const f = fixture(t);
	assert.equal(f.run().status, 0);
	f.write("docs/new-guide.md", "[Missing](./missing.md)\n");
	const result = f.run();
	assert.equal(result.status, 1);
	assert.match(result.output, /new-guide.md: broken local link/);
});

test("reference-style links validate encoded paths as well as inline links", (t) => {
	const f = fixture(t);
	f.write(
		"docs/guide.md",
		"[Read][details]\n\n[details]: <./more%20details.md#usage>\n",
	);
	assert.equal(f.run().status, 1);
	f.write("docs/more details.md", "# Usage\n");
	assert.equal(f.run().status, 0);
});

test("multiple current reports fail even if both are indexed", (t) => {
	const f = fixture(t);
	f.write("docs/evidence/2025-12-31-release.md", "# Previous release\n");
	f.write(
		"docs/evidence/README.md",
		"[Current](./2026-01-01-release.md)\n[Previous](./2025-12-31-release.md)\n",
	);
	assert.match(f.run().output, /exactly one current dated release report/);
	rmSync(path.join(f.root, "docs/evidence/2025-12-31-release.md"));
	f.write(
		"docs/evidence/README.md",
		"[Current](./2026-01-01-release.md)\n[Previous](https://example.org/immutable/previous.md)\n",
	);
	assert.equal(f.run().status, 0);
});

test("an evidence filename in prose is not an indexed report", (t) => {
	const f = fixture(t);
	f.write("docs/evidence/README.md", "See ./2026-01-01-release.md later.\n");
	assert.match(f.run().output, /missing report entry/);
});

test("privacy checks apply to untracked documentation but not fixture text", (t) => {
	const f = fixture(t);
	f.write("docs/local.md", "/Users/example/private-report.json\n");
	assert.match(f.run().output, /local workstation path/);
	rmSync(path.join(f.root, "docs/local.md"));
	f.write("testdata/md/example.md", "[Fictional link](./not-a-guide.md)\n");
	assert.equal(f.run().status, 0);
});

test("retired architecture plans cannot return as current guidance", (t) => {
	const f = fixture(t);
	f.write("docs/adr/0004-nextjs-control-plane.md", "# Old runtime\n");
	assert.match(f.run().output, /retired documentation path/);
});

test("tracked files removed in a cleanup do not cause read failures", (t) => {
	const f = fixture(t);
	f.write("docs/old.md", "# Previous guide\n");
	execFileSync("git", ["-C", f.root, "add", "."]);
	rmSync(path.join(f.root, "docs/old.md"));
	assert.equal(f.run().status, 0);
});
