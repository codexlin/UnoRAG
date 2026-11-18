import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	assertPublicDebug,
	clarificationChoices,
	configurationFingerprint,
	extractFacts,
	loadMultiTurnPlan,
	matrixOptions,
	privateOutputDirectory,
	ROOT,
	scoreTurn,
	validateIdentity,
	validateManifest,
} from "../scripts/acceptance/lib/multi-turn-contract.mjs";
import {
	OwnedLibraries,
	planSummary,
	runMultiTurnMatrix,
} from "../scripts/acceptance/multi-turn-matrix.mjs";

const plan = await loadMultiTurnPlan();
const specification = JSON.parse(
	await readFile(resolve(ROOT, "testdata/multi-turn/manifest.json"), "utf8"),
);
const revision = "a".repeat(40);
const environment = {
	UNORAG_ACCEPT_MULTI_TURN_MATRIX: "YES",
	UNORAG_BASE_URL: "http://127.0.0.1:3001",
	UNORAG_EXPECT_REVISION: revision,
	UNORAG_ADMIN_EMAIL: "synthetic@example.invalid",
	UNORAG_ADMIN_PASSWORD: "synthetic-test-password",
};
const ready = {
	live_ready: true,
	ask_ready: true,
	chat_model: "chat-fixture",
	judge_model: "judge-fixture",
	embedding_model: "embed-fixture",
	rerank_model: null,
	release: { revision, channel: "stable", version: "1.0.0" },
};
const sources = Object.fromEntries(
	plan.documents.map((d) => [
		d.id,
		{
			document_id: d.entity === "a" ? "doc-a" : "doc-b",
			version_id: `version-${d.id}`,
			generation_id: `generation-${d.id}`,
		},
	]),
);
const citation = (key, index = 1) => ({
	index,
	doc_id: sources[key].document_id,
	document_version_id: sources[key].version_id,
	text: plan.documents.find((d) => d.id === key).bytes.toString("utf8"),
});
const response = (answer, citations = [citation("a")], extra = {}) => ({
	status: 200,
	requestId: "request-1",
	body: { answer, citations, refused: false, refuse_reason: null, ...extra },
});
const score = (expect, result, choices = []) =>
	scoreTurn(expect, result, { documents: plan.documents, sources, choices });
const answerA = { kind: "answer", facts: ["a.price"] };
const clarify = response(
	"你指的是1.「青岚方案 A」、2.「星河方案 B」中的哪一个？",
	[],
	{ refused: true, refuse_reason: "ambiguous" },
);

test("versioned synthetic matrix covers nine scenarios and the real five-minute boundary", () => {
	assert.equal(plan.scenarios.length, 9);
	assert.equal(plan.clarification_ttl_ms, 300_000);
	assert.equal(plan.origin, "synthetic");
	assert.match(plan.sha256, /^[a-f0-9]{64}$/u);
	for (const doc of plan.documents) {
		assert.ok(doc.bytes.length > 0);
		assert.match(doc.sha256, /^[a-f0-9]{64}$/u);
		assert.ok(
			extractFacts(doc.bytes.toString()).some(
				(fact) => fact.value === doc.price,
			),
		);
	}
	const expiry = plan.scenarios.find((s) => s.expiry);
	assert.deepEqual(
		expiry.steps.filter((s) => s.op === "wait").map((s) => s.phase),
		["midpoint", "expired"],
	);
	assert.ok(expiry.steps.some((s) => s.expect?.unchanged));
	assert.ok(
		plan.deterministic_coverage.some(
			(c) => c.live_status === "NOT_RUN_REQUIRES_PERMISSION_TOPOLOGY",
		),
	);
});

test("manifest rejects unknown controls, traversal, missing sources and invalid sequence dependencies", () => {
	for (const mutate of [
		(s) => {
			s.contract_version = 9;
		},
		(s) => {
			s.documents[0].file = "../../runtime.secret";
		},
		(s) => {
			s.documents[0].file = s.documents[1].file;
		},
		(s) => {
			s.documents[0].date = "2027-02-30";
		},
		(s) => {
			s.documents[0].price = -1;
		},
		(s) => {
			s.documents[0].content = "alternate oracle";
		},
		(s) => {
			s.scenarios[0].steps[0].expect.facts = ["unknown.price"];
		},
		(s) => {
			s.scenarios[0].steps[0].expect.facts = ["choice2.price"];
		},
		(s) => {
			s.scenarios[0].steps[0].context = "archive";
		},
		(s) => {
			s.scenarios[0].steps.push({ op: "delete", document: "a" });
		},
		(s) => {
			s.scenarios[0].steps.push({ op: "configure-model" });
		},
		(s) => {
			s.scenarios[1].id = s.scenarios[0].id;
		},
		(s) => {
			s.scenarios = s.scenarios.filter((c) => !c.expiry);
		},
		(s) => {
			s.clarification_ttl_ms = 1;
		},
	]) {
		const copy = structuredClone(specification);
		mutate(copy);
		assert.throws(() => validateManifest(copy));
	}
});

test("plan is offline, requires no credentials, and never claims a release PASS", (t) => {
	t.mock.method(globalThis, "fetch", () => {
		throw new Error("plan must not use HTTP");
	});
	const options = matrixOptions(
		["--plan"],
		new Proxy(
			{},
			{
				get(_target, key) {
					assert.notEqual(key, "UNORAG_ADMIN_PASSWORD");
					return undefined;
				},
			},
		),
	);
	const summary = planSummary(plan, options);
	assert.equal(summary.result, "PLAN_ONLY");
	assert.equal(summary.release_gate, "not_evaluated");
	assert.equal(summary.include_expiry, true);
	assert.equal(summary.expiry_wait_ms, 301_000);
	assert.ok(!JSON.stringify(summary).includes("bytes"));
	const processResult = spawnSync(
		process.execPath,
		["scripts/acceptance/multi-turn-matrix.mjs", "--plan"],
		{ cwd: ROOT, env: {}, encoding: "utf8" },
	);
	assert.equal(processResult.status, 0, processResult.stderr);
	assert.equal(JSON.parse(processResult.stdout).result, "PLAN_ONLY");
});

test("missing opt-in, credentials or release revision are BLOCKED exit 2, not skipped passes", () => {
	for (const field of Object.keys(environment)) {
		const env = { ...environment };
		delete env[field];
		assert.throws(
			() => matrixOptions([], env),
			(error) => error.exitCode === 2,
			field,
		);
	}
	const result = spawnSync(
		process.execPath,
		["scripts/acceptance/multi-turn-matrix.mjs"],
		{ cwd: ROOT, env: {}, encoding: "utf8" },
	);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /BLOCKED/u);
	assert.doesNotMatch(result.stdout, /PASS/u);
});

test("release defaults include expiry and development skipping never evaluates the release gate", () => {
	const release = matrixOptions([], environment);
	assert.equal(release.development, false);
	assert.equal(release.includeExpiry, true);
	assert.throws(
		() => matrixOptions(["--skip-expiry"], environment),
		(e) => e.exitCode === 2,
	);
	assert.throws(() =>
		matrixOptions(
			["--development", "--skip-expiry", "--include-expiry"],
			environment,
		),
	);
	const development = matrixOptions(
		["--development", "--skip-expiry"],
		environment,
	);
	assert.equal(development.includeExpiry, false);
	const summary = planSummary(plan, development);
	assert.equal(summary.release_gate, "not_evaluated");
	assert.equal(
		summary.scenarios.find((s) => s.id === "expiry").selected,
		false,
	);
});

test("unsafe origins, paths, arbitrary libraries, config overrides and ambiguous flag values are rejected", () => {
	for (const args of [
		["--base-url", "http://example.invalid"],
		["--base-url", "https://user:password@example.invalid"],
		["--base-url", "https://example.invalid/path"],
		["--base-url", "https://example.invalid/?key=secret"],
		["--expected-revision", "abc1234"],
		["--output-dir", "/tmp/public-report"],
		["--library-id", "existing-library"],
		["--keep-library"],
		["--model", "different-model"],
		["--skip-expiry", "false"],
		["--password", "secret"],
	])
		assert.throws(
			() => matrixOptions(args, environment),
			(e) => e.exitCode === 2,
		);
});

test("release identity binds clean HEAD and runtime channel/revision; development is explicitly separate", () => {
	const options = matrixOptions([], environment);
	const local = { revision, dirty: false };
	for (const channel of ["stable", "prerelease"])
		assert.doesNotThrow(() =>
			validateIdentity(options, local, {
				...ready,
				release: { ...ready.release, channel },
			}),
		);
	for (const [git, health] of [
		[{ ...local, dirty: true }, ready],
		[{ ...local, revision: "b".repeat(40) }, ready],
		[local, { ...ready, ask_ready: false }],
		[
			local,
			{ ...ready, release: { ...ready.release, revision: "b".repeat(40) } },
		],
		[
			local,
			{ ...ready, release: { ...ready.release, channel: "development" } },
		],
	])
		assert.throws(
			() => validateIdentity(options, git, health),
			(e) => e.exitCode === 2,
		);
	assert.doesNotThrow(() =>
		validateIdentity(
			{ ...options, development: true },
			{ ...local, dirty: true },
			{
				...ready,
				release: { revision: "development", channel: "development" },
			},
		),
	);
});

test("ready configuration fingerprint contains only model names and release identity", () => {
	const fingerprint = configurationFingerprint({
		...ready,
		api_key: "DO_NOT_RECORD",
		endpoint: "https://private.invalid",
	});
	assert.deepEqual(Object.keys(fingerprint).sort(), [
		"channel",
		"chat_model",
		"embedding_model",
		"judge_model",
		"rerank_model",
		"revision",
		"sha256",
	]);
	assert.doesNotMatch(JSON.stringify(fingerprint), /DO_NOT_RECORD|private/u);
	assert.notEqual(
		configurationFingerprint({ ...ready, judge_model: "another" }).sha256,
		fingerprint.sha256,
	);
	assert.throws(
		() => configurationFingerprint({ ...ready, embedding_model: undefined }),
		(e) => e.exitCode === 2,
	);
});

test("public debug checks nested fields without rejecting their appearance as ordinary text", () => {
	assert.doesNotThrow(() =>
		assertPublicDebug({ answer: "pending_clarification is a field name" }),
	);
	for (const key of [
		"pending_clarification",
		"memory_provenance",
		"grounded_question",
	])
		assert.throws(() =>
			assertPublicDebug({ turns: [{ retrieval_debug: { [key]: {} } }] }),
		);
});

test("strict positive scoring requires exact facts, current source version and inline supported citations", () => {
	for (const answer of [
		"青岚方案 A 的含税报价为 1379 元人民币 [1]。",
		"方案 A 报价为人民币 1,379 元 [1]。",
		"1379元 [1]",
	])
		assert.equal(score(answerA, response(answer)).ok, true, answer);
	assert.equal(
		score(
			{ kind: "answer", facts: ["a.date"] },
			response("生效日期是2027年4月16日 [1]。"),
		).ok,
		true,
	);
	assert.equal(
		score(
			{ kind: "answer", facts: ["a.date"] },
			response("生效日期是2027-04-16 [1]。"),
		).ok,
		true,
	);
	for (const bad of [
		response("方案 A 价格是 2683 元 [1]。"),
		response("方案 A 价格是 137 元 [1]。"),
		response("方案 A 价格是 1379 元。"),
		response("方案 A 价格是 1379 元 [99]。"),
		response("方案 A 价格不是 1379 元 [1]。"),
		response("方案 A 价格可能是 1379 元 [1]。"),
		response("方案 A 价格是 1379 元，也可能是 9999 元 [1]。"),
		response("方案 A 价格是 1379 元 [1]。", []),
		response("方案 A 价格是 1379 元 [1]。", [citation("b")]),
		response("方案 A 价格是 1379 元 [1]。", [
			{ ...citation("a"), document_version_id: "old-version" },
		]),
		response("方案 A 价格是 1379 元 [1]。", [
			{ ...citation("a"), generation_id: "old-generation" },
		]),
		response("方案 A 价格是 1379 元 [1]。", [
			{ ...citation("a"), text: "无报价证据" },
		]),
		{ ...response("1379元[1]"), requestId: null },
		{ ...response("1379元[1]"), status: 503 },
	])
		assert.equal(score(answerA, bad).ok, false, JSON.stringify(bad));
});

test("comparison scoring rejects swapped subject-value pairs and ungrounded extra sources", () => {
	const expect = { kind: "answer", facts: ["a.price", "b.price"] };
	const citations = [citation("a"), citation("b", 2)];
	assert.equal(
		score(
			expect,
			response("方案 A 为1379元[1]；方案 B 为2683元[2]。", citations),
		).ok,
		true,
	);
	assert.equal(
		score(
			expect,
			response("方案 A 为2683元[2]；方案 B 为1379元[1]。", citations),
		).ok,
		false,
	);
	assert.equal(
		score(expect, response("1379元[1]；2683元[2]。", citations)).ok,
		false,
	);
	assert.equal(score(answerA, response("1379元[1]。", citations)).ok, false);
});

test("sentence and paragraph footers support each preceding fact from the live response shapes", () => {
	const comparison = { kind: "answer", facts: ["a.price", "b.price"] };
	for (const answer of [
		"青岚方案 A 的含税报价为 1379 元人民币；星河方案 B 的含税报价为 2683 元人民币。  \n[1][2]",
		"方案 A 为1379元。方案 B 为2683元。[1][2]",
		"方案 A 为1379元；方案 B 为2683元[1][2]。",
		"方案 A 为1379元；方案 B 为2683元。\n\n[1][2]",
	])
		assert.equal(
			score(comparison, response(answer, [citation("a"), citation("b", 2)])).ok,
			true,
			answer,
		);
	assert.equal(
		score(
			{ kind: "answer", facts: ["b.date"] },
			response("星河方案 B 的生效日期为 2028 年 9 月 23 日。[1]", [
				citation("b"),
			]),
		).ok,
		true,
	);
	assert.equal(
		score(
			{ kind: "answer", facts: ["a2.price", "a2.date"] },
			response(
				"青岚方案 A 的含税报价为 4517 元人民币；生效日期为 2029 年 6 月 12 日 [1]。",
				[citation("a2")],
			),
		).ok,
		true,
	);
});

test("footer citation sets do not forgive swapped subjects, numbers, versions or source bodies", () => {
	const expect = { kind: "answer", facts: ["a.price", "b.price"] };
	const good = "方案 A 为1379元；方案 B 为2683元。\n[1][2]";
	const citations = [citation("a"), citation("b", 2)];
	for (const answer of [
		"方案 A 为2683元；方案 B 为1379元。\n[1][2]",
		"方案 A 为1379元；方案 B 为9999元。\n[1][2]",
		"方案 A 为1379元；方案 B 为2683元；方案 A 还有2683元的报价。\n[1][2]",
	])
		assert.equal(score(expect, response(answer, citations)).ok, false, answer);
	for (const changed of [
		[{ ...citation("a"), document_version_id: "superseded" }, citation("b", 2)],
		[{ ...citation("a"), generation_id: "superseded" }, citation("b", 2)],
		[{ ...citation("a"), doc_id: "foreign-doc" }, citation("b", 2)],
		[{ ...citation("a"), text: "方案 B 的报价为1379元。" }, citation("b", 2)],
		[
			{ ...citation("a"), text: "方案 A 的报价为2683元。" },
			{ ...citation("b", 2), text: "方案 B 的报价为1379元。" },
		],
	])
		assert.equal(score(expect, response(good, changed)).ok, false);
	assert.equal(
		score(
			{ kind: "answer", facts: ["a2.price", "a2.date"] },
			response("方案 A 为4517元；生效日期为2029-06-12。[1]", [
				{ ...citation("a2"), document_version_id: sources.a.version_id },
			]),
		).ok,
		false,
	);
});

test("local citation assignments and unrelated paragraphs remain hard scope boundaries", () => {
	const expect = { kind: "answer", facts: ["a.price", "b.price"] };
	const citations = [citation("a"), citation("b", 2)];
	for (const answer of [
		"方案 A 为1379元[2]；方案 B 为2683元[1]。",
		"方案 A 为1379元[2]；方案 B 为2683元。[1][2]",
		"方案 A 为1379元。\n\n方案 B 为2683元。[1][2]",
		"方案 A 为1379元。\n\n方案 B 为2683元。\n\n[1][2]",
	])
		assert.equal(score(expect, response(answer, citations)).ok, false, answer);
	assert.equal(
		score(
			expect,
			response("方案 A 为1379元。[1]\n\n方案 B 为2683元。[2]", citations),
		).ok,
		true,
	);
});

test("a correct occurrence cannot mask another wrong assertion or unsupported repeated fact", () => {
	const expect = { kind: "answer", facts: ["a.price", "b.price"] };
	const citations = [citation("a"), citation("b", 2)];
	for (const answer of [
		"方案 A 为1379元[1]；方案 B 为1379元[1]；方案 B 为2683元[2]。",
		"方案 A 为1379元[1]；方案 B 为2683元[2]。\n\n方案 A 为1379元。",
	]) {
		const result = score(expect, response(answer, citations));
		assert.equal(result.ok, false);
		assert.ok(result.failures.includes("unsupported_fact_occurrence"));
	}
});

test("B is the entity alias even with reversed candidates; ordinal selection follows returned order", () => {
	const reversed = clarificationChoices(
		"你指的是1.「星河方案 B」、2.「青岚方案 A」中的哪一个？",
		plan.documents,
	);
	assert.deepEqual(reversed, ["b", "a"]);
	const letter = plan.scenarios
		.find((s) => s.id === "clarify-letter")
		.steps.at(-1);
	assert.equal(letter.question, "B");
	assert.deepEqual(letter.expect.facts, ["b.date"]);
	const a = response("方案 A 的生效日期为2027-04-16[1]。", [citation("a")]);
	const b = response("方案 B 的生效日期为2028-09-23[1]。", [citation("b")]);
	assert.equal(score(letter.expect, b, reversed).ok, true);
	assert.equal(score(letter.expect, a, reversed).ok, false);
	assert.equal(
		score({ kind: "answer", facts: ["choice2.date"] }, a, reversed).ok,
		true,
	);
	assert.equal(
		score({ kind: "answer", facts: ["choice2.date"] }, b, reversed).ok,
		false,
	);
});

test("clarification must enumerate both candidates and preserve their order after invalid choices", () => {
	assert.deepEqual(score({ kind: "clarify" }, clarify).choices, ["a", "b"]);
	assert.equal(
		score({ kind: "clarify", unchanged: true }, clarify, ["a", "b"]).ok,
		true,
	);
	assert.equal(
		score({ kind: "clarify", unchanged: true }, clarify, ["b", "a"]).ok,
		false,
	);
	for (const answer of [
		"请重新提问",
		"你指的是1.「方案 A」、2.「未知方案」？",
		"你指的是1.「方案 A」、2.「方案 A」？",
		"你指的是1.「方案 A」、2.「方案 B」、3.「方案 C」？",
	]) {
		assert.equal(
			score(
				{ kind: "clarify" },
				{ ...clarify, body: { ...clarify.body, answer } },
			).ok,
			false,
		);
	}
});

test("isolation/expiry denials cannot pass through technical errors, leaked facts or recreated candidates", () => {
	const deny = { kind: "deny" };
	const valid = response("请带上对象名称再问一次。", [], {
		refused: true,
		refuse_reason: "ambiguous",
	});
	assert.equal(score(deny, valid).ok, true);
	assert.equal(score(deny, clarify).ok, false);
	for (const reason of [
		"judge_unavailable",
		"invalid_rewrite",
		"invalid_judgement_action",
		"timeout",
		"",
	])
		assert.equal(
			score(deny, { ...valid, body: { ...valid.body, refuse_reason: reason } })
				.ok,
			false,
		);
	for (const body of [
		{ ...valid.body, answer: "没有权限，但旧价格为1379元" },
		{ ...valid.body, citations: [citation("a")] },
		{ ...valid.body, refused: false },
		{ ...valid.body, retrieval_debug: { pending_clarification: {} } },
	])
		assert.equal(score(deny, { ...valid, body }).ok, false);
});

test("owned cleanup only deletes IDs created by this run and continues after a failed deletion", async () => {
	const deleted = [];
	let created = 0;
	const client = {
		request: async (path, request = {}) => {
			if (request.method === "POST") {
				assert.match(request.body.name, /^multi-turn-test /u);
				return { id: `owned-${++created}` };
			}
			if (request.method === "DELETE") {
				deleted.push(path);
				if (path.endsWith("owned-2"))
					throw new Error("controlled deletion failure");
				return null;
			}
			return [];
		},
	};
	const owned = new OwnedLibraries(client, "multi-turn-test");
	await owned.create("main");
	await owned.create("isolated");
	assert.throws(() => owned.assertOwned("preexisting-customer-library"));
	assert.deepEqual(
		(await owned.cleanup(10)).map((r) => r.result),
		["FAIL", "PASS"],
	);
	assert.deepEqual(deleted, [
		"/api/libraries/owned-2",
		"/api/libraries/owned-1",
	]);
});

test("private output rejects traversal and symlink escapes", async () => {
	const root = resolve(ROOT, ".unorag/acceptance");
	await mkdir(root, { recursive: true });
	const parent = await mkdtemp(join(root, "multi-turn-test-"));
	const outside = await mkdtemp(join(tmpdir(), "unorag-matrix-test-"));
	try {
		await symlink(outside, resolve(parent, "escape"));
		await assert.rejects(
			privateOutputDirectory(resolve(parent, "escape"), "multi-turn-run"),
			/symlink/u,
		);
		assert.deepEqual(await readdir(outside), []);
		await assert.rejects(privateOutputDirectory(outside, "multi-turn-run"));
		const output = await privateOutputDirectory(parent, "multi-turn-valid");
		assert.equal((await stat(output)).mode & 0o077, 0);
	} finally {
		await rm(parent, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("runner records failed raw HTTP privately, excludes login secrets, and cleans all own libraries on setup failure", async (t) => {
	let created = 0;
	const deleted = [];
	const visited = [];
	t.mock.method(globalThis, "fetch", async (url, request = {}) => {
		const path = new URL(url).pathname;
		visited.push(path);
		let body,
			status = 200;
		if (path === "/api/rag/health/ready") body = ready;
		else if (path === "/api/auth/session") body = { mustChangePassword: false };
		else if (path === "/api/libraries" && request.method === "POST")
			body = { id: `owned-${++created}` };
		else if (path.endsWith("/documents")) {
			status = 500;
			body = { detail: "controlled ingest failure" };
		} else if (request.method === "DELETE") {
			deleted.push(path);
			body = {};
		} else if (path === "/api/libraries") body = [];
		else throw new Error(`unexpected request: ${path}`);
		return new Response(JSON.stringify(body), {
			status,
			headers: {
				"x-request-id": "request-controlled",
				...(path === "/api/auth/session"
					? { "set-cookie": "session=synthetic-secret-cookie; HttpOnly" }
					: {}),
			},
		});
	});
	const options = matrixOptions(
		["--development", "--skip-expiry"],
		environment,
	);
	const result = await runMultiTurnMatrix(
		options,
		environment.UNORAG_ADMIN_PASSWORD,
	);
	try {
		assert.equal(result.exitCode, 1);
		assert.equal(result.report.result, "FAIL");
		assert.equal(result.report.release_gate, "not_evaluated");
		assert.equal(result.report.cleanup.length, 3);
		assert.ok(result.report.cleanup.every((r) => r.result === "PASS"));
		assert.equal(deleted.length, 3);
		assert.ok(
			visited.every((p) => !p.includes("settings") && !p.includes("config")),
		);
		const report = await readFile(
			resolve(result.output, "report.json"),
			"utf8",
		);
		assert.doesNotMatch(
			report,
			/synthetic-test-password|synthetic-secret-cookie/u,
		);
		assert.equal(
			(await stat(resolve(result.output, "report.json"))).mode & 0o077,
			0,
		);
		let observedFailure = false;
		for (const file of await readdir(resolve(result.output, "raw"))) {
			const raw = await readFile(resolve(result.output, "raw", file), "utf8");
			assert.doesNotMatch(
				raw,
				/synthetic-test-password|synthetic-secret-cookie|\/api\/auth\/session/u,
			);
			if (JSON.parse(raw).status === 500) observedFailure = true;
			assert.equal(
				(await stat(resolve(result.output, "raw", file))).mode & 0o077,
				0,
			);
		}
		assert.equal(observedFailure, true);
	} finally {
		await rm(result.output, { recursive: true, force: true });
	}
});
