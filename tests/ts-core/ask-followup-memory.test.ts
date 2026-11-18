import assert from "node:assert/strict";
import test from "node:test";
import type { LanguageModel } from "ai";
import {
	AnswerStreamAdapter,
	StructuredOutputAdapter,
} from "../../src/core/ai";
import {
	CLARIFICATION_TTL_MS,
	clarificationSelection,
	latestClarification,
	readPendingClarification,
} from "../../src/core/ask-graph/clarification";
import { mapQdrantHitToInternalCitation } from "../../src/core/retrieval/citation-mapper";
import { rewriteFollowup } from "../../src/server/http/ask/followup-rewrite";

test("explicit topic changes cut older referents but keep later elliptical turns", async () => {
	const old = [
		{ role: "user" as const, content: "采购合同甲的付款金额是多少？" },
		{ role: "assistant" as const, content: "采购合同甲的付款金额是 80 元。" },
	];
	const latest = [
		{ role: "user" as const, content: "采购合同乙的付款金额是多少？" },
		{ role: "assistant" as const, content: "采购合同乙的付款金额是 95 元。" },
	];
	for (const tail of [
		[],
		[
			{ role: "user" as const, content: "它什么时候生效？" },
			{ role: "assistant" as const, content: "2027 年 8 月 1 日。" },
		],
	]) {
		const result = await rewriteFollowup(
			"它的到期日期呢？",
			[...old, ...latest, ...tail],
			async (input) => {
				assert.deepEqual(input.history, [...latest, ...tail]);
				return { resolution: "resolved", subjects: ["采购合同乙"] };
			},
		);
		assert.equal(result.query, "采购合同乙的到期日期呢？");
	}
	const comparison = [
		{
			role: "user" as const,
			content: "采购合同甲和采购合同乙的付款金额各是多少？",
		},
		{
			role: "assistant" as const,
			content: "采购合同甲为 80 元，采购合同乙为 95 元。",
		},
	];
	const result = await rewriteFollowup(
		"它的到期日期呢？",
		[...old, ...comparison],
		async (input) => {
			assert.deepEqual(input.history, comparison);
			return {
				resolution: "ambiguous",
				subjects: ["采购合同甲", "采购合同乙"],
			};
		},
	);
	assert.ok(result.clarification);
	assert.equal(result.pendingClarification?.candidates.length, 2);
});

import { NativeAskPolicySchema } from "../../src/server/http/ask/policy";
import { runtimeModule } from "../helpers/native-ask-runtime";

const question = "请帮我核对它的生效日期";
const documents = ["方案 A", "方案 B"].map((title, i) => ({
	id: `contract-${i}`,
	title,
	body: i ? "2026-09-01" : "2026-04-01",
}));
const history = (subject: string) => [
	{ role: "user", content: `${subject}的报价是多少？` },
	{ role: "assistant", content: "报价为 300 元。" },
];
const unexpected = (): never => {
	throw new Error("unexpected call");
};

test("identical follow-ups resolve against their own history before retrieval; ambiguous references stop before retrieval", async (t) => {
	const { NativeAskRuntime } = await runtimeModule;
	const { DrizzleActiveGenerationResolver } = await import(
		"../../src/server/retrieval/active-generation-resolver"
	);
	t.mock.method(
		DrizzleActiveGenerationResolver.prototype,
		"resolve",
		async () => ({
			libraryId: "lib",
			generationIds: ["active"],
			resolvedAt: new Date(),
		}),
	);
	const queries: string[] = [];
	const adapter = new StructuredOutputAdapter(
		{} as LanguageModel,
		async (request) => {
			if (request.schemaName === "conflict")
				return {
					comparison: "single current source",
					resolution: "consistent",
					conflict_evidence: [],
				};
			if (request.schemaName === "judge") {
				assert.ok(
					String(request.messages[0].content).includes(
						queries.at(-1) ?? "missing query",
					),
				);
				return {
					sufficient: true,
					action: "generate",
					reason: "covered",
					evidence_ids: ["e1"],
				};
			}
			assert.equal(request.schemaName, "rewrite");
			const input = JSON.parse(String(request.messages[0].content));
			assert.equal(input.question, question);
			const subjects = documents
				.map((d) => d.title)
				.filter((s) =>
					input.history.some((m: { content: string }) => m.content.includes(s)),
				);
			return {
				resolution: subjects.length === 1 ? "resolved" : "ambiguous",
				subjects,
			};
		},
		{ maxAttempts: 1 },
	);
	const runtime = () =>
		new NativeAskRuntime(
			{
				tenantId: "org",
				workspaceId: "ws",
				principalId: "reader",
				groupIds: [],
			} as never,
			"lib",
			undefined,
			NativeAskPolicySchema.parse({}),
			{
				structured: adapter,
				retrieval: {
					retrieve: async ({ query, scope }) => {
						queries.push(query);
						assert.deepEqual(scope.activeGenerationIds, ["active"]);
						const citations = documents
							.filter((d) => query.includes(d.title))
							.map((doc) =>
								mapQdrantHitToInternalCitation(
									{
										id: doc.id,
										score: 1,
										payload: {
											doc_id: doc.id,
											library_id: "lib",
											title: doc.title,
											text: doc.body,
											chunk_index: 0,
											tenant_id: "org",
											workspace_id: "ws",
											generation_id: "active",
											acl_scope: "workspace",
											document_version_id: "version",
											record_type: "chunk",
										},
									},
									1,
								),
							);
						return {
							citations,
							debug: {
								usedHybrid: false,
								hybridEnabled: false,
								hybridFailed: false,
								hybridError: null,
								usedRerank: false,
								rerankFailed: false,
								retrievalMode: "dense",
								denseHitCount: citations.length,
								activeGenerationCount: 1,
							},
						};
					},
				},
				answer: new AnswerStreamAdapter(
					{} as LanguageModel,
					async function* (request) {
						const content = JSON.stringify(request.messages);
						const cited = documents.filter((d) => content.includes(d.body));
						assert.equal(cited.length, 1);
						assert.ok(content.includes(queries.at(-1) ?? "missing query"));
						yield cited[0].body;
					},
				),
			},
		);
	for (const doc of documents) {
		const graph = runtime();
		const result = await graph.invoke({
			session_id: doc.id,
			question,
			history: history(doc.title),
		});
		assert.equal(result.question, question);
		assert.equal(result.query_type, "follow_up");
		assert.equal(result.rewritten_question, `请帮我核对${doc.title}的生效日期`);
		assert.equal(result.retrieval_debug?.rewrite, "history_resolved");
		assert.equal(result.refused, false, JSON.stringify(result.judgement));
		let answer = "";
		for await (const part of graph.streamAnswer(result)) answer += part;
		assert.equal(answer, doc.body);
		assert.deepEqual(
			result.citations?.map((c) => c.id),
			[doc.id],
		);
	}
	const ambiguous = await runtime().invoke({
		session_id: "comparison",
		question,
		history: history("方案 A 和方案 B"),
	});
	assert.match(ambiguous.answer ?? "", /方案 A.*方案 B/);
	assert.equal(ambiguous.judgement?.action, "clarify");
	assert.deepEqual(ambiguous.citations, []);
	assert.equal(queries.length, 2);
	const pending = readPendingClarification(
		ambiguous.retrieval_debug?.pending_clarification,
	);
	assert.ok(pending);
	const clarificationHistory = [
		...history("方案 A 和方案 B"),
		{ role: "user", content: question },
		{
			role: "assistant",
			content: ambiguous.answer,
			pending_clarification: pending,
		},
	];
	for (const reply of ["B", "第二个", "方案 B"]) {
		const resumedRuntime = runtime();
		const resumed = await resumedRuntime.invoke({
			question: reply,
			history: clarificationHistory,
		});
		assert.equal(resumed.question, reply);
		assert.equal(resumed.retrieval_debug?.rewrite, "clarification_resolved");
		assert.equal(resumed.rewritten_question, "请帮我核对方案 B的生效日期");
		assert.equal(resumed.refused, false);
		let answer = "";
		for await (const part of resumedRuntime.streamAnswer(resumed))
			answer += part;
		assert.equal(answer, "2026-09-01");
	}
	const before = queries.length;
	for (const reply of ["C", "我选第五个", "第99项", "选第三个吧"]) {
		const unknownChoice = await runtime().invoke({
			question: reply,
			history: clarificationHistory,
		});
		assert.match(unknownChoice.answer ?? "", /方案 A.*方案 B/);
		assert.equal(queries.length, before);
		assert.deepEqual(
			unknownChoice.retrieval_debug?.pending_clarification,
			pending,
		);
	}
});

test("a clarification expiring after history authorization never re-enters text resolution", async (t) => {
	const now = Date.now();
	t.mock.timers.enable({ apis: ["Date"], now });
	const pending = {
		version: 1 as const,
		question,
		candidates: ["方案 A", "方案 B"],
		createdAt: now - CLARIFICATION_TTL_MS + 1,
		expiresAt: now + 1,
	};
	assert.ok(readPendingClarification(pending));
	t.mock.timers.tick(1);
	const result = await rewriteFollowup(
		"我选第二个",
		[
			{ role: "user", content: question },
			{
				role: "assistant",
				content: "请选择方案 A 或方案 B",
				pending_clarification: pending,
			},
		],
		unexpected,
	);
	assert.equal(result.mode, "clarification_expired");
	assert.equal(result.pendingClarification, undefined);
	assert.equal(result.query, "");
	assert.ok(result.clarification);
	assert.doesNotMatch(result.clarification, /方案 [AB]/);
});

test("clarification choices are bounded, unique, and expire without changing the question", () => {
	const now = 100_000;
	const pending = {
		version: 1 as const,
		question,
		candidates: ["方案 A", "方案 B"],
		createdAt: now,
		expiresAt: now + CLARIFICATION_TTL_MS,
	};
	assert.deepEqual(clarificationSelection("选第二个", pending), {
		subject: "方案 B",
	});
	assert.deepEqual(clarificationSelection("后者", pending), {
		subject: "方案 B",
	});
	assert.deepEqual(clarificationSelection("Ａ", pending), {
		subject: "方案 A",
	});
	assert.equal(clarificationSelection("采购合同的价格是多少？", pending), null);
	assert.equal(
		readPendingClarification(pending, now + CLARIFICATION_TTL_MS),
		undefined,
	);
	assert.equal(
		readPendingClarification(
			{ ...pending, expiresAt: now + CLARIFICATION_TTL_MS + 1 },
			now,
		),
		undefined,
	);
	assert.equal(
		readPendingClarification({ ...pending, candidates: ["A", "A"] }, now),
		undefined,
	);
	assert.equal(
		clarificationSelection("B", {
			...pending,
			candidates: ["合同 B", "方案 B"],
		})?.subject,
		undefined,
	);
	assert.equal(
		latestClarification(
			[
				{ role: "assistant", pending_clarification: pending },
				{ role: "assistant", content: "new topic" },
			],
			now,
		),
		undefined,
	);
});

test("reference resolution forwards only recent complete exchanges and never accepts invented subjects", async () => {
	const messages = ["old", "one", "two", "three"].flatMap((subject) => [
		{ role: "user" as const, content: "它的报价呢？" },
		{ role: "assistant" as const, content: `${subject}的报价为 300 元。` },
	]);
	const result = await rewriteFollowup(question, messages, async (input) => {
		assert.deepEqual(input.history, messages.slice(2));
		return { resolution: "resolved", subjects: ["old"] };
	});
	assert.ok(result.clarification);
	assert.ok(!result.clarification.includes("old"));
	assert.ok(
		(
			await rewriteFollowup(
				question,
				[...messages, ...history("x".repeat(8001))],
				unexpected,
			)
		).clarification,
	);
	assert.ok((await rewriteFollowup(question, [], unexpected)).clarification);
	for (const dangling of [
		"它什么时候生效？",
		"请确认它什么时候生效",
		"该合同什么时候生效？",
		"When does it take effect?",
	]) {
		assert.ok((await rewriteFollowup(dangling, [], unexpected)).clarification);
	}
	assert.ok(
		(
			await rewriteFollowup(question, messages, async () => ({
				resolution: "standalone",
				subjects: [],
			}))
		).clarification,
	);
	const elliptical = await rewriteFollowup(
		"生效日期是什么时候？",
		history("方案 B"),
		async () => ({ resolution: "resolved", subjects: ["方案 B"] }),
	);
	assert.equal(elliptical.query, "方案 B：生效日期是什么时候？");
	assert.equal(
		(
			await rewriteFollowup(
				"采购合同的生效日期是什么时候？",
				messages,
				unexpected,
			)
		).mode,
		"identity_self_contained",
	);
	await assert.rejects(
		rewriteFollowup(question, messages, async () => {
			throw new Error("provider unavailable");
		}),
		/provider unavailable/,
	);
});
