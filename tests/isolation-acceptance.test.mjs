import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = await readFile(
	path.join(root, "scripts/acceptance/s1_s2_isolation.sh"),
	"utf8",
);

test("isolation acceptance can bootstrap through the pinned Ops image", () => {
	assert.match(script, /run_topology\(\)/);
	assert.match(script, /mk_compose --profile ops run --rm --user 0/);
	assert.match(script, /--entrypoint node inspect-lifecycle/);
	assert.match(script, /run_topology bootstrap/);
	assert.match(script, /run_topology cleanup/);
});

test("isolation acceptance covers ACL-protected metadata surfaces", () => {
	for (const check of [
		"S3.metadata_document_list",
		"S3.metadata_owner_inventory",
		"S3.metadata_library_counts",
		"S3.metadata_job_list",
	]) {
		assert.match(script, new RegExp(check.replaceAll(".", "\\.")));
	}
	for (const probe of ["versions:", "acl:", "job:", "download:"]) {
		assert.match(script, new RegExp(`"${probe}`));
	}
	assert.match(script, /record "S3\.metadata_\$\{probe_name\}"/);
	assert.match(script, /expected 404/);
});
