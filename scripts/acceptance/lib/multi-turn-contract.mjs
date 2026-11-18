import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_BLOCKED, parseArguments } from "./runtime.mjs";

export const ROOT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../..",
);
export const FIXTURES = resolve(ROOT, "testdata/multi-turn");
export const EXPIRY_MS = 300_000;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const normalized = (value) =>
	String(value)
		.normalize("NFKC")
		.replace(/[\s*`_]/gu, "");

function keys(value, allowed) {
	assert.ok(value && typeof value === "object" && !Array.isArray(value));
	for (const key of Object.keys(value))
		assert.ok(allowed.includes(key), `unknown field: ${key}`);
}

export function validateManifest(spec) {
	keys(spec, [
		"schema_version",
		"contract_version",
		"origin",
		"clarification_ttl_ms",
		"documents",
		"scenarios",
		"deterministic_coverage",
	]);
	assert.equal(spec.schema_version, 1);
	assert.equal(spec.contract_version, 1);
	assert.equal(spec.origin, "synthetic");
	assert.equal(spec.clarification_ttl_ms, EXPIRY_MS);
	assert.equal(spec.documents?.length, 3);
	assert.deepEqual(spec.documents.map((d) => d.id).sort(), ["a", "a2", "b"]);
	const files = new Set();
	for (const doc of spec.documents) {
		keys(doc, ["id", "entity", "file", "name", "aliases", "price", "date"]);
		assert.ok(["a", "b"].includes(doc.entity));
		assert.equal(basename(doc.file), doc.file);
		assert.match(doc.file, /^[a-z0-9-]+\.md$/u);
		assert.ok(!files.has(doc.file), "duplicate fixture");
		files.add(doc.file);
		assert.ok(typeof doc.name === "string" && doc.name.length > 0);
		assert.ok(Array.isArray(doc.aliases) && doc.aliases.includes(doc.name));
		assert.ok(doc.aliases.every((a) => typeof a === "string" && a.length > 0));
		assert.ok(Number.isSafeInteger(doc.price) && doc.price > 0);
		assert.match(doc.date, /^\d{4}-\d{2}-\d{2}$/u);
		assert.equal(new Date(doc.date).toISOString().slice(0, 10), doc.date);
	}
	assert.ok(Array.isArray(spec.scenarios) && spec.scenarios.length > 0);
	const ids = new Set();
	for (const scenario of spec.scenarios) {
		keys(scenario, ["id", "library", "expiry", "steps"]);
		assert.match(scenario.id, /^[a-z][a-z0-9-]+$/u);
		assert.ok(!ids.has(scenario.id), "duplicate scenario");
		ids.add(scenario.id);
		assert.ok(["main", "lifecycle"].includes(scenario.library));
		assert.ok(scenario.expiry === undefined || scenario.expiry === true);
		assert.ok(Array.isArray(scenario.steps) && scenario.steps.length > 0);
		let choices = false,
			archive = false,
			exchanges = 0;
		for (const step of scenario.steps) {
			const fields = {
				ask: ["op", "question", "expect", "context", "library"],
				archive: ["op", "turns"],
				reload: ["op"],
				replace: ["op", "document", "replacement"],
				delete: ["op", "document"],
				wait: ["op", "phase"],
			};
			assert.ok(fields[step.op], "unknown operation");
			keys(step, fields[step.op]);
			if (step.op === "ask") {
				assert.ok(typeof step.question === "string" && step.question.trim());
				assert.ok([undefined, "archive", "fresh"].includes(step.context));
				assert.ok([undefined, "isolated"].includes(step.library));
				if (step.context === "archive")
					assert.ok(archive, "archive must precede continuation");
				keys(step.expect, ["kind", "facts", "unchanged"]);
				assert.ok(["answer", "clarify", "deny"].includes(step.expect.kind));
				if (step.expect.kind === "answer") {
					assert.ok(step.expect.facts?.length > 0);
					for (const fact of step.expect.facts) {
						assert.match(fact, /^(a|b|a2|choice2)\.(price|date)$/u);
						if (fact.startsWith("choice2"))
							assert.ok(choices, "choice requires a prior clarification");
					}
				} else assert.equal(step.expect.facts, undefined);
				if (step.expect.unchanged !== undefined) {
					assert.equal(step.expect.unchanged, true);
					assert.equal(step.expect.kind, "clarify");
					assert.ok(choices);
				}
				if (step.expect.kind === "clarify") choices = true;
				if (!step.context && !step.library) exchanges += 1;
			} else if (step.op === "archive") {
				assert.ok(exchanges > 0);
				if (step.turns) {
					assert.ok(Array.isArray(step.turns) && step.turns.length > 0);
					assert.ok(
						step.turns.every(
							(i) => Number.isInteger(i) && i >= 0 && i < exchanges,
						),
					);
				}
				archive = true;
			} else if (step.op === "reload") assert.ok(archive);
			else if (step.op === "wait") {
				assert.equal(scenario.expiry, true);
				assert.ok(choices);
				assert.ok(["midpoint", "expired"].includes(step.phase));
			} else {
				assert.equal(
					scenario.library,
					"lifecycle",
					"mutations require the owned lifecycle library",
				);
				assert.ok(spec.documents.some((doc) => doc.id === step.document));
				if (step.op === "replace") assert.equal(step.replacement, "a2");
			}
		}
	}
	assert.ok(
		spec.scenarios.some(
			(s) =>
				s.expiry &&
				s.steps.some((s) => s.op === "wait" && s.phase === "expired"),
		),
		"expiry coverage is required",
	);
	assert.ok(
		Array.isArray(spec.deterministic_coverage) &&
			spec.deterministic_coverage.length > 0,
	);
	for (const coverage of spec.deterministic_coverage) {
		keys(coverage, ["boundary", "tests", "live_status"]);
		assert.ok(typeof coverage.boundary === "string" && coverage.boundary);
		assert.ok(
			coverage.tests.every((p) =>
				/^tests\/ts-core\/[a-z0-9-]+\.test\.ts$/u.test(p),
			),
		);
		assert.ok(
			coverage.live_status.startsWith("NOT_RUN_") ||
				coverage.live_status.startsWith("DETERMINISTIC_ONLY_"),
		);
	}
	return spec;
}

export async function loadMultiTurnPlan(
	manifestPath = resolve(FIXTURES, "manifest.json"),
) {
	const spec = validateManifest(
		JSON.parse(await readFile(manifestPath, "utf8")),
	);
	const documents = [];
	const fixtureRoot = await realpath(FIXTURES);
	for (const doc of spec.documents) {
		const path = await realpath(resolve(FIXTURES, doc.file));
		assert.ok(path.startsWith(fixtureRoot + sep), "fixture escaped its root");
		const bytes = await readFile(path);
		assert.ok(bytes.length > 0 && bytes.length < 32_000);
		const facts = extractFacts(bytes.toString("utf8"));
		assert.ok(
			facts.some((f) => f.kind === "price" && f.value === doc.price),
			"fixture price differs from oracle",
		);
		assert.ok(
			facts.some((f) => f.kind === "date" && f.value === doc.date),
			"fixture date differs from oracle",
		);
		documents.push({ ...doc, bytes, sha256: sha256(bytes) });
	}
	return {
		...spec,
		documents,
		sha256: sha256(
			JSON.stringify({ spec, hashes: documents.map((d) => d.sha256) }),
		),
	};
}

export function blocked(message) {
	return Object.assign(new Error(message), { exitCode: EXIT_BLOCKED });
}

export function matrixOptions(argv, env = {}) {
	const args = parseArguments(argv);
	const allowed = [
		"plan",
		"development",
		"include-expiry",
		"skip-expiry",
		"base-url",
		"email",
		"password-env",
		"expected-revision",
		"output-dir",
	];
	for (const key of Object.keys(args))
		if (!allowed.includes(key)) throw blocked(`unsupported option: --${key}`);
	for (const key of allowed.slice(0, 4))
		if (args[key] !== undefined && args[key] !== true)
			throw blocked(`--${key} is a flag`);
	if (args["include-expiry"] && args["skip-expiry"])
		throw blocked("conflicting expiry flags");
	const development = args.development === true;
	if (args["skip-expiry"] && !development)
		throw blocked("--skip-expiry requires --development");
	const baseUrl = args["base-url"] ?? env.UNORAG_BASE_URL;
	if (baseUrl) {
		let url;
		try {
			url = new URL(baseUrl);
		} catch {
			throw blocked("invalid base URL");
		}
		if (
			!(
				url.protocol === "https:" ||
				(url.protocol === "http:" &&
					["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
			) ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		)
			throw blocked(
				"target requires HTTPS or loopback HTTP, without credentials/path/query",
			);
	}
	const expectedRevision =
		args["expected-revision"] ?? env.UNORAG_EXPECT_REVISION;
	if (expectedRevision && !/^[a-f0-9]{40}$/u.test(expectedRevision))
		throw blocked("expected revision must be a full lowercase Git SHA");
	const outputDirectory = resolve(
		ROOT,
		args["output-dir"] ?? ".unorag/acceptance",
	);
	const privateRoot = resolve(ROOT, ".unorag/acceptance");
	if (
		outputDirectory !== privateRoot &&
		!outputDirectory.startsWith(privateRoot + sep)
	)
		throw blocked("outputs must stay inside .unorag/acceptance");
	const passwordEnv = args["password-env"] ?? "UNORAG_ADMIN_PASSWORD";
	if (!/^[A-Z][A-Z0-9_]*$/u.test(passwordEnv))
		throw blocked("invalid password environment variable name");
	const options = {
		plan: args.plan === true,
		development,
		includeExpiry: !args["skip-expiry"],
		baseUrl,
		expectedRevision,
		email: args.email ?? env.UNORAG_ADMIN_EMAIL,
		passwordEnv,
		outputDirectory,
	};
	if (!options.plan) {
		if (env.UNORAG_ACCEPT_MULTI_TURN_MATRIX !== "YES")
			throw blocked("UNORAG_ACCEPT_MULTI_TURN_MATRIX=YES is required");
		if (!baseUrl || !options.email || !env[passwordEnv])
			throw blocked(
				"base URL, admin email and password environment variable are required",
			);
		if (!development && !expectedRevision)
			throw blocked("UNORAG_EXPECT_REVISION is required for release");
	}
	return options;
}

export function validateIdentity(options, local, health) {
	if (!health?.live_ready || !health?.ask_ready)
		throw blocked("target is not live/Ask ready");
	if (options.development) return;
	if (local.revision !== options.expectedRevision || local.dirty)
		throw blocked("release requires matching HEAD and a clean worktree");
	const release = health.release;
	if (
		release?.revision !== options.expectedRevision ||
		!["stable", "prerelease"].includes(release?.channel)
	)
		throw blocked(
			"runtime revision/channel does not match the release candidate",
		);
}

export function configurationFingerprint(health) {
	const configuration = {};
	for (const key of ["chat_model", "judge_model", "embedding_model"]) {
		if (typeof health?.[key] !== "string" || !health[key].trim())
			throw blocked(`ready response is missing ${key}`);
		configuration[key] = health[key];
	}
	if (health.rerank_model !== null && typeof health.rerank_model !== "string")
		throw blocked("ready response is missing rerank_model");
	configuration.rerank_model = health.rerank_model;
	configuration.revision = health.release?.revision ?? null;
	configuration.channel = health.release?.channel ?? null;
	return { ...configuration, sha256: sha256(JSON.stringify(configuration)) };
}

export async function privateOutputDirectory(parent, runId) {
	assert.match(runId, /^multi-turn-[a-zA-Z0-9-]+$/u);
	const output = resolve(parent, runId);
	assert.ok(output.startsWith(resolve(ROOT, ".unorag/acceptance") + sep));
	let current = ROOT;
	for (const part of output.slice(ROOT.length + 1).split(sep)) {
		current = resolve(current, part);
		await mkdir(current, { mode: 0o700 }).catch((error) => {
			if (error.code !== "EEXIST") throw error;
		});
		const stat = await lstat(current);
		if (stat.isSymbolicLink() || !stat.isDirectory())
			throw blocked("private output path must not contain symlinks");
		if (current === output && (stat.mode & 0o077) !== 0)
			throw blocked("output directory must be private");
	}
	return output;
}

export function assertPublicDebug(body) {
	function visit(value) {
		if (!value || typeof value !== "object") return;
		for (const [key, item] of Object.entries(value)) {
			assert.ok(
				![
					"pending_clarification",
					"memory_provenance",
					"grounded_question",
				].includes(key),
				"private debug field exposed",
			);
			visit(item);
		}
	}
	visit(body);
}

export function extractFacts(value) {
	const text = String(value)
		.normalize("NFKC")
		.replace(/\r\n?/gu, "\n")
		.replace(/[^\S\n]|[*`_]/gu, "")
		.replace(/(?<=\d),(?=\d{3}(?:\D|$))/gu, "");
	const facts = [];
	for (const m of text.matchAll(
		/(?:¥|￥)(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)(?:元|人民币|CNY|RMB)/giu,
	))
		facts.push({
			kind: "price",
			value: Number(m[1] ?? m[2]),
			index: m.index,
			text,
		});
	for (const m of text.matchAll(
		/(\d{4})(?:年|[-/])(\d{1,2})(?:月|[-/])(\d{1,2})(?:日|号)?/gu,
	))
		facts.push({
			kind: "date",
			value: `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`,
			index: m.index,
			text,
		});
	return facts;
}

function citationScopes(text) {
	const paragraphs = [];
	let start = 0;
	for (const separator of [
		...text.matchAll(/\n{2,}/gu),
		{ index: text.length, 0: "" },
	]) {
		const end = separator.index;
		const paragraph = text.slice(start, end);
		// A standalone citation footer belongs to the immediately preceding
		// paragraph, never to every earlier paragraph in the answer.
		if (/^(?:\[\d+\])+[。.!！]?$/u.test(paragraph) && paragraphs.length)
			paragraphs.at(-1).end = end;
		else paragraphs.push({ start, end });
		start = end + separator[0].length;
	}
	return paragraphs.flatMap((paragraph) => {
		const scopes = [];
		let start = paragraph.start;
		for (const group of text
			.slice(paragraph.start, paragraph.end)
			.matchAll(/\[\d+\](?:\s*\[\d+\])*/gu)) {
			const end = paragraph.start + group.index;
			scopes.push({
				start,
				end,
				paragraphStart: paragraph.start,
				indexes: [...group[0].matchAll(/\[(\d+)\]/gu)].map((m) => Number(m[1])),
			});
			// An explicit local citation cannot borrow a later paragraph footer
			// to repair an incorrect source assignment.
			start = end + group[0].length;
		}
		return scopes;
	});
}

function factSubject(hit, documents, start) {
	const prefix = hit.text.slice(start, hit.index);
	const mentions = documents
		.map((doc) => ({
			entity: doc.entity,
			at: Math.max(
				...doc.aliases.map((alias) => prefix.lastIndexOf(normalized(alias))),
			),
		}))
		.sort((left, right) => right.at - left.at);
	return mentions[0]?.at >= 0 ? mentions[0].entity : undefined;
}

function supportsFact(
	hit,
	doc,
	source,
	citations,
	documents,
	scopes,
	allowImplicitSubject,
) {
	const scope = scopes.find((s) => hit.index >= s.start && hit.index < s.end);
	if (!scope) return false;
	const subject = factSubject(hit, documents, scope.paragraphStart);
	if (subject ? subject !== doc.entity : !allowImplicitSubject) return false;
	return citations.some(
		(citation) =>
			scope.indexes.includes(citation.index) &&
			(citation.doc_id ?? citation.document_id) === source.document_id &&
			citation.document_version_id === source.version_id &&
			extractFacts(
				citation.body ?? citation.text ?? citation.snippet ?? "",
			).some((fact) => {
				if (fact.kind !== hit.kind || fact.value !== hit.value) return false;
				const separator = fact.text.lastIndexOf("\n\n", fact.index);
				const subject = factSubject(
					fact,
					documents,
					separator < 0 ? 0 : separator + 2,
				);
				return !subject || subject === doc.entity;
			}),
	);
}

export function clarificationChoices(answer, documents) {
	const matches = [
		...normalized(answer).matchAll(/(\d+)\.[「“]([^」”]+)[」”]/gu),
	];
	assert.equal(
		matches.length,
		2,
		"clarification must enumerate exactly two choices",
	);
	const choices = matches.map((m, index) => {
		assert.equal(Number(m[1]), index + 1, "choice order must be explicit");
		const doc = documents.find(
			(d) => d.id !== "a2" && d.aliases.some((a) => normalized(a) === m[2]),
		);
		assert.ok(doc, "unknown candidate");
		return doc.id;
	});
	assert.equal(new Set(choices).size, 2, "duplicated candidate");
	return choices;
}

const DENIAL_REASONS = new Set([
	"ambiguous",
	"no_evidence",
	"insufficient_evidence",
	"document_scope_unavailable",
]);

export function scoreTurn(
	expect,
	response,
	{ documents, sources, choices = [] },
) {
	const failures = [];
	const check = (valid, reason) => {
		if (!valid) failures.push(reason);
	};
	const body = response.body ?? {};
	check(response.status === 200, "http_status");
	check(
		typeof response.requestId === "string" && response.requestId.length > 0,
		"request_id",
	);
	check(
		typeof body.answer === "string" && body.answer.trim().length > 0,
		"answer_missing",
	);
	check(Array.isArray(body.citations), "citations_missing");
	try {
		assertPublicDebug(body);
	} catch {
		failures.push("private_debug");
	}
	const citations = Array.isArray(body.citations) ? body.citations : [];
	const facts = extractFacts(body.answer ?? "");
	if (expect.kind !== "answer") {
		check(body.refused === true, "not_refused");
		check(citations.length === 0, "refusal_citations");
		check(
			DENIAL_REASONS.has(body.refuse_reason),
			"technical_or_unknown_refusal",
		);
		check(facts.length === 0, "refusal_leaks_fact");
		let nextChoices;
		if (expect.kind === "clarify") {
			check(body.refuse_reason === "ambiguous", "not_clarification");
			try {
				nextChoices = clarificationChoices(body.answer, documents);
				if (expect.unchanged)
					check(
						JSON.stringify(nextChoices) === JSON.stringify(choices),
						"choices_changed",
					);
			} catch {
				failures.push("invalid_choices");
			}
		} else
			check(
				!/\d+\.[「“]/u.test(normalized(body.answer)),
				"stale_candidates_recreated",
			);
		return { ok: failures.length === 0, failures, choices: nextChoices };
	}
	check(body.refused === false, "answer_refused");
	check(!body.refuse_reason, "answer_has_refusal_reason");
	check(
		!/(?:可能|大约|不确定|并非|不是|未确认|不为)/u.test(body.answer ?? ""),
		"uncertain_or_negated_fact",
	);
	const expected = expect.facts.map((fact) => {
		let [id, kind] = fact.split(".");
		if (id === "choice2") id = choices[1];
		const doc = documents.find((d) => d.id === id);
		check(!!doc && !!sources[id], "expected_source_missing");
		return { doc, kind, source: sources[id] };
	});
	const indexes = new Set();
	for (const c of citations) {
		check(
			Number.isInteger(c.index) && c.index > 0 && !indexes.has(c.index),
			"citation_index",
		);
		indexes.add(c.index);
		check(
			expected.some(
				({ source }) =>
					source &&
					(c.doc_id ?? c.document_id) === source.document_id &&
					c.document_version_id === source.version_id &&
					(!c.generation_id || c.generation_id === source.generation_id),
			),
			"wrong_or_stale_source",
		);
	}
	check(citations.length > 0, "answer_without_citations");
	for (const m of normalized(body.answer ?? "").matchAll(/\[(\d+)\]/gu))
		check(indexes.has(Number(m[1])), "unknown_inline_citation");
	const scopes = citationScopes(facts[0]?.text ?? "");
	const allowImplicitSubject =
		new Set(expected.map(({ doc }) => doc?.entity)).size === 1;
	for (const fact of facts) {
		const candidates = expected.filter(
			({ doc, source }) => doc && source && doc[fact.kind] === fact.value,
		);
		check(candidates.length > 0, "unexpected_fact");
		check(
			candidates.some(({ doc, source }) =>
				supportsFact(
					fact,
					doc,
					source,
					citations,
					documents,
					scopes,
					allowImplicitSubject,
				),
			),
			"unsupported_fact_occurrence",
		);
	}
	for (const { doc, kind, source } of expected) {
		if (!doc || !source) continue;
		const hits = facts.filter((f) => f.kind === kind && f.value === doc[kind]);
		check(hits.length > 0, `missing_${doc.id}_${kind}`);
		const supported = hits.some((hit) =>
			supportsFact(
				hit,
				doc,
				source,
				citations,
				documents,
				scopes,
				allowImplicitSubject,
			),
		);
		check(supported, `unsupported_${doc.id}_${kind}`);
	}
	return { ok: failures.length === 0, failures };
}
