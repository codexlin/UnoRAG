import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const referenceRoot = new URL("../../../../eval/reference/", import.meta.url);

async function readJsonLines(name: string): Promise<Record<string, unknown>[]> {
	const text = await readFile(new URL(name, referenceRoot), "utf8");
	return text
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("migrated evaluation reference corpora remain parseable and uniquely identified", async () => {
	const cases = await readJsonLines("eval_cases.jsonl");
	const ablations = await readJsonLines("ablation_cases.jsonl");
	assert.equal(cases.length, 40);
	assert.equal(ablations.length, 8);

	const all = [...cases, ...ablations];
	const ids = all.map((entry) => entry.id);
	assert.equal(
		ids.every((id) => typeof id === "string" && id.length > 0),
		true,
	);
	assert.equal(new Set(ids).size, ids.length);
	assert.equal(
		all.every(
			(entry) =>
				typeof entry.kind === "string" &&
				entry.expect !== null &&
				typeof entry.expect === "object",
		),
		true,
	);
});

test("reference baselines preserve zero-leakage release fuses", async () => {
	for (const name of ["ci-deterministic.json", "release.json"]) {
		const baseline = JSON.parse(
			await readFile(new URL(`baselines/${name}`, referenceRoot), "utf8"),
		) as { hard?: Record<string, unknown> };
		assert.equal(baseline.hard?.tenant_workspace_group_leak, 0);
		assert.equal(baseline.hard?.inactive_or_deleted_generation_recall, 0);
	}
});
