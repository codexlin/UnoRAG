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
	contract_version?: number;
	documents: {
		path?: string;
		filename?: string;
		content?: string;
		origin?: string;
	}[];
	positive: { file: string; key_facts: string[] }[];
};

test("contract v3 preserves natural wording and checks conflict plus clause-scoped controls", async () => {
	const plan = await loadBusinessPlan();
	assert.equal(safePlanSummary(plan).contract_version, 3);
	assert.equal(plan.positive.length, 85);
	const conflict = plan.positive.find(
		(item: { id: string }) => item.id === "48dea4319e71a530",
	);
	assert.equal(conflict.expect_conflict, true);
	assert.deepEqual(conflict.key_facts, [
		"30日",
		"60日",
		"万分之五",
		"口径不一致",
	]);
	assert.equal(
		plan.positive.filter(
			(item: { expect_conflict?: boolean }) => item.expect_conflict === false,
		).length,
		2,
	);
	const backup = plan.positive.find(
		(item: { id: string }) => item.id === "bc6bbc477c4a4ea7",
	);
	assert.ok(backup);
	assert.deepEqual(backup.key_facts, ["备份校验"]);
	assert.ok(!backup.question.includes("原文名称"));
	const rollback = plan.positive.find(
		(item: { id: string }) => item.id === "4c0d633c9b865946",
	);
	assert.ok(rollback);
	assert.deepEqual(rollback.key_facts, ["应用镜像", "不自动"]);
	const migration = plan.positive.find((item: { question: string }) =>
		item.question.includes("数据库迁移应按什么方式"),
	);
	assert.ok(migration);
	assert.equal(migration.file, rollback.file);
	assert.deepEqual(migration.key_facts, ["前向修复"]);
});

test("business matrix rejects unknown review contracts", async () => {
	await invalidManifest((input) => {
		input.contract_version = 99;
	}, /unsupported contract/u);
});

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
