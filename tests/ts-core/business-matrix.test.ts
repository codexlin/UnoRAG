import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	loadBusinessPlan,
	safePlanSummary,
} from "../../scripts/acceptance/business-matrix.mjs";

test("business matrix resolves real bytes, varied formats and independently labelled origins", async () => {
	const plan = await loadBusinessPlan();
	const summary = safePlanSummary(plan);
	assert.ok(summary.files >= 20);
	assert.ok(summary.positive >= 80 && summary.negative >= 10);
	assert.ok(summary.files_by_origin["repository-fixture"] > 0);
	assert.ok(summary.files_by_origin.synthetic > 0);
	assert.equal(
		new Set(
			plan.documents.map((doc: { filename: string }) =>
				doc.filename.split(".").at(-1),
			),
		).size,
		4,
	);
	assert.ok(
		plan.documents.every(
			(doc: { bytes: Buffer; sha256: string }) =>
				doc.bytes.length > 0 && /^[a-f0-9]{64}$/u.test(doc.sha256),
		),
	);
	assert.ok(!JSON.stringify(summary).includes("content"));
});

type TestSpecification = {
	documents: {
		path?: string;
		filename?: string;
		content?: string;
		origin?: string;
	}[];
	positive: { file: string; key_facts: string[] }[];
};

async function invalidManifest(
	change: (value: TestSpecification) => void,
	expected: RegExp,
) {
	const folder = await mkdtemp(join(tmpdir(), "unorag-business-oracle-"));
	try {
		const input = JSON.parse(
			await readFile(
				new URL("../../testdata/business/scenarios.json", import.meta.url),
				"utf8",
			),
		);
		change(input);
		const path = join(folder, "cases.json");
		await writeFile(path, JSON.stringify(input));
		await assert.rejects(loadBusinessPlan(path), expected);
	} finally {
		await rm(folder, { recursive: true, force: true });
	}
}

test("business matrix rejects duplicate filenames instead of overwriting an uploaded oracle", async () => {
	await invalidManifest(
		(input) => input.documents.push(input.documents[0]),
		/duplicate fixture/u,
	);
});

test("business matrix cannot read files outside the repository fixture tree", async () => {
	await invalidManifest((input) => {
		input.documents[0] = { path: "package.json" };
	}, /inside testdata/u);
});

test("business matrix rejects unsafe generated filenames", async () => {
	await invalidManifest((input) => {
		input.documents[15].filename = "../escape.md";
	}, /equal/u);
});

test("business matrix requires a source for every expected answer", async () => {
	await invalidManifest((input) => {
		input.positive[0].file = "not-in-the-corpus.md";
	}, /missing fixture/u);
});

test("business matrix requires reference answers to actually contain their claimed facts", async () => {
	await invalidManifest((input) => {
		input.positive[0].key_facts = ["unsupported-oracle-fact"];
	}, /not supported/u);
});
