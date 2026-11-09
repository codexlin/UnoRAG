import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	loadBusinessPlan,
	safePlanSummary,
} from "../../scripts/acceptance/business-matrix.mjs";
import { scorePositiveCase } from "../../src/evaluation/scoring";

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
	assert.ok(plan.positive.length >= 85);
	for (const id of [
		"pilot-backup-manifest",
		"pilot-backup-mechanism",
		"pilot-release-title",
	]) {
		const scenario = plan.positive.find(
			(item: { id: string }) => item.id === id,
		);
		assert.equal(scenario?.require_citation_facts, true, id);
	}
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

test("the backup fact accepts scoped paraphrases only with cited checklist text", async () => {
	const plan = await loadBusinessPlan();
	const gold = plan.positive.find(
		(item: { id: string }) => item.id === "bc6bbc477c4a4ea7",
	);
	assert.ok(gold);
	const citation = {
		index: 1,
		filename: gold.file,
		record_type: "section",
		text: "必须完成数据库备份校验、回归测试和回滚方案检查。",
	};
	const response = {
		httpStatus: 200,
		refused: false,
		latencyMs: 1,
		citations: [citation],
	};
	for (const answer of [
		"订单系统发布前，数据库备份需要做「校验」检查 [1]。",
		"上线前应对数据库备份进行验证 [1]。",
		"需要验证备份的完整性 [1]，不能只确认备份文件存在。",
		"必须做数据库备份校验 [1]。",
	]) {
		const score = scorePositiveCase(gold, { ...response, answer });
		assert.equal(score.ok, true, answer);
		assert.deepEqual(score.matchedFacts, ["备份校验"]);
	}
	for (const answer of [
		"无需进行备份校验 [1]。",
		"不必校验数据库备份 [1]。",
		"数据库备份不需要做校验 [1]。",
		"只需确认备份文件存在 [1]。",
		"只需确认备份文件存在，也可以校验数据库备份 [1]。",
		"备份校验可以省略 [1]。",
		"数据库备份已经完成，发布配置需要校验 [1]。",
	]) {
		assert.equal(
			scorePositiveCase(gold, { ...response, answer }).ok,
			false,
			answer,
		);
	}
	const answer = "上线前应对数据库备份进行验证 [1]。";
	for (const wrongCitation of [
		{ ...citation, filename: "biz-backup-runbook.md" },
		{ ...citation, text: "上线前须由测试负责人和运维负责人共同签字。" },
		{ ...citation, text: "对数据库备份进行验证。" },
		{ ...citation, record_type: "figure" },
	]) {
		assert.equal(
			scorePositiveCase(gold, {
				...response,
				answer,
				citations: [wrongCitation],
			}).ok,
			false,
		);
	}
	const unreferenced = scorePositiveCase(gold, {
		...response,
		answer: "上线前应对数据库备份进行验证。",
	});
	assert.equal(unreferenced.ok, false);
	assert.deepEqual(unreferenced.missingEvidenceFacts, ["备份校验"]);
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
		const generated = input.documents.find((doc) => doc.origin === "synthetic");
		assert.ok(generated);
		generated.filename = "../escape.md";
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
