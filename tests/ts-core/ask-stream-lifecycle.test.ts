import assert from "node:assert/strict";
import test from "node:test";

import {
	ASK_TOKEN_BUFFER_LIMIT,
	ASK_TOKEN_FLUSH_MS,
	createAskStreamLifecycle,
} from "../../src/components/app/ask-stream-lifecycle";
import {
	type AskTurnsAction,
	askTurnsReducer,
	type LocalTurn,
} from "../../src/components/app/ask-turn-state";
import {
	type ApiAskResponse,
	type AskStreamHandlers,
	askQuestionStream,
} from "../../src/lib/api";

function deferred() {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function harness() {
	const requests: {
		handlers: AskStreamHandlers;
		signal: AbortSignal;
		completion: ReturnType<typeof deferred>;
	}[] = [];
	const timers = new Map<object, () => void>();
	const lifecycle = createAskStreamLifecycle(
		(_input, handlers, signal) => {
			const completion = deferred();
			requests.push({ handlers, signal, completion });
			return completion.promise;
		},
		{
			set(callback, delay) {
				assert.equal(delay, ASK_TOKEN_FLUSH_MS);
				const ticket = {};
				timers.set(ticket, callback);
				return ticket;
			},
			clear(handle) {
				timers.delete(handle as object);
			},
		},
	);
	let turns: LocalTurn[] = [];
	let session = "";
	let citationUpdates = 0;
	const actions: AskTurnsAction[] = [];
	function dispatch(action: AskTurnsAction) {
		actions.push(action);
		turns = askTurnsReducer(turns, action);
	}
	function start(
		turnId = "same-turn",
		libraryId = "library",
		threadId?: string,
	) {
		lifecycle.cancel();
		dispatch({
			type: "begin",
			replaceTurnId: turns.some((turn) => turn.id === turnId)
				? turnId
				: undefined,
			turn: {
				id: turnId,
				question: "q",
				answer: "",
				citations: [],
				pending: true,
			},
		});
		return lifecycle.run(
			{ question: "q", libraryId, threadId },
			{
				onToken: (token) => dispatch({ type: "token", turnId, token }),
				onMeta: (meta) => {
					session = meta.session_id;
					dispatch({ type: "meta", turnId, patch: { mode: meta.mode } });
				},
				onCitations: () => {
					citationUpdates += 1;
					dispatch({
						type: "citations",
						turnId,
						citations: [],
						evidenceMs: 12,
					});
				},
				onDone: (result) => {
					session = result.session_id;
					dispatch({
						type: "complete",
						turnId,
						turn: {
							id: turnId,
							question: "q",
							answer: result.answer,
							citations: [],
							pending: false,
						},
					});
				},
				onTerminal: ({ cancelled, error }) =>
					dispatch({
						type: "terminal",
						turnId,
						cancelled,
						error:
							!cancelled && error instanceof Error ? error.message : undefined,
						completedAt: 100,
						durationMs: 10,
					}),
			},
		);
	}
	function tick() {
		for (const callback of [...timers.values()]) callback();
	}
	return {
		lifecycle,
		requests,
		timers,
		actions,
		start,
		tick,
		dispatch,
		get turns() {
			return turns;
		},
		get session() {
			return session;
		},
		get citationUpdates() {
			return citationUpdates;
		},
	};
}

function done(answer = "final"): ApiAskResponse {
	return {
		session_id: "new-session",
		question: "q",
		answer,
		citations: [],
		mode: "llm",
		refused: false,
		retrieval_debug: {},
	};
}

function lateEvents(handlers: AskStreamHandlers) {
	handlers.onMeta?.({ session_id: "stale", mode: "stale", refused: true });
	handlers.onCitations?.([]);
	handlers.onToken?.("stale");
	handlers.onError?.("stale error");
	handlers.onDone?.({ ...done("stale"), session_id: "stale" });
}

test("same-turn retry ignores every old event, rejected catch, timer, and finally", async () => {
	const h = harness();
	const old = h.start();
	h.requests[0].handlers.onToken?.("old tail");
	const staleFlush = [...h.timers.values()][0];
	const current = h.start();
	assert.equal(h.requests[0].signal.aborted, true);
	assert.equal(h.turns[0].id, "same-turn");
	const snapshot = h.turns;
	lateEvents(h.requests[0].handlers);
	staleFlush();
	h.requests[0].completion.reject(new Error("late transport failure"));
	await old;
	assert.equal(h.turns, snapshot);
	assert.equal(h.session, "");
	assert.equal(h.citationUpdates, 0);
	assert.equal(h.requests[1].signal.aborted, false);
	h.requests[1].handlers.onToken?.("new tail");
	h.tick();
	assert.equal(h.turns[0].answer, "new tail");
	assert.equal(h.turns[0].pending, true);
	h.requests[1].handlers.onDone?.(done("new tail"));
	h.requests[1].completion.resolve();
	await current;
	assert.equal(h.turns[0].pending, false);
});

test("high-frequency tokens batch by time and size without losing Unicode or final tail", async () => {
	const h = harness();
	const running = h.start();
	const handlers = h.requests[0].handlers;
	const tokens = [
		"\u4e2d",
		"\ud83d",
		"\ude80",
		"e",
		"\u0301",
		...Array(100).fill("x"),
	];
	for (const token of tokens) handlers.onToken?.(token);
	assert.equal(h.turns[0].answer, "");
	assert.equal(h.timers.size, 1);
	h.tick();
	assert.equal(h.turns[0].answer, tokens.join(""));
	assert.equal(h.actions.filter((action) => action.type === "token").length, 1);
	const large = "y".repeat(ASK_TOKEN_BUFFER_LIMIT * 2);
	handlers.onToken?.(large);
	assert.equal(h.timers.size, 0);
	assert.equal(h.turns[0].answer, tokens.join("") + large);
	for (let index = 0; index < ASK_TOKEN_BUFFER_LIMIT; index += 1) {
		handlers.onToken?.("z");
	}
	assert.equal(h.timers.size, 0);
	handlers.onToken?.("tail");
	const full = `${tokens.join("")}${large}${"z".repeat(ASK_TOKEN_BUFFER_LIMIT)}tail`;
	handlers.onDone?.(done(full));
	assert.deepEqual(
		h.actions.slice(-2).map((action) => action.type),
		["token", "complete"],
	);
	assert.equal(h.turns[0].answer, full);
	assert.equal(h.timers.size, 0);
	const snapshot = h.turns;
	lateEvents(handlers);
	h.requests[0].completion.reject(new Error("error after done"));
	await running;
	assert.equal(h.turns, snapshot);
});

test("done remains authoritative, including refusal instead of provisional streamed text", async () => {
	const h = harness();
	const running = h.start();
	h.requests[0].handlers.onToken?.("provisional");
	h.requests[0].handlers.onDone?.({ ...done(""), refused: true });
	assert.equal(h.turns[0].answer, "");
	assert.equal(h.turns[0].pending, false);
	h.requests[0].completion.resolve();
	await running;
});

test("a cleared flush cannot drain a later batch in the same attempt", async () => {
	const h = harness();
	const running = h.start();
	const request = h.requests[0];
	request.handlers.onToken?.("first");
	const staleFlush = [...h.timers.values()][0];
	request.handlers.onToken?.("x".repeat(ASK_TOKEN_BUFFER_LIMIT));
	const painted = h.turns[0].answer;
	request.handlers.onToken?.("later");
	staleFlush();
	assert.equal(h.turns[0].answer, painted);
	assert.equal(h.timers.size, 1);
	h.tick();
	assert.equal(h.turns[0].answer, `${painted}later`);
	h.lifecycle.cancel();
	request.completion.resolve();
	await running;
});

test("old successful completion cannot release a newer attempt", async () => {
	const h = harness();
	const old = h.start();
	h.requests[0].handlers.onDone?.(done());
	assert.equal(h.requests[0].signal.aborted, true);
	const current = h.start();
	h.requests[0].completion.resolve();
	await old;
	h.requests[1].handlers.onToken?.("still current");
	h.tick();
	assert.equal(h.turns[0].answer, "still current");
	h.lifecycle.cancel();
	assert.equal(h.requests[1].signal.aborted, true);
	h.requests[1].completion.resolve();
	await current;
});

for (const ending of [
	"cancel",
	"error event",
	"reject",
	"abort rejection",
	"EOF",
] as const) {
	test(`${ending} flushes the pending tail exactly once before terminal state`, async () => {
		const h = harness();
		const running = h.start();
		const request = h.requests[0];
		request.handlers.onToken?.("received tail");
		const staleFlush = [...h.timers.values()][0];
		if (ending === "cancel") h.lifecycle.cancel();
		if (ending === "error event") request.handlers.onError?.("provider failed");
		if (ending === "reject")
			request.completion.reject(new Error("network failed"));
		if (ending === "abort rejection")
			request.completion.reject(new DOMException("stop", "AbortError"));
		if (ending !== "reject" && ending !== "abort rejection")
			request.completion.resolve();
		await running;
		assert.equal(h.turns[0].answer, "received tail");
		assert.equal(h.turns[0].pending, false);
		assert.equal(
			h.turns[0].cancelled,
			ending === "cancel" || ending === "abort rejection",
		);
		if (ending === "error event")
			assert.equal(h.turns[0].error, "provider failed");
		if (ending === "reject") assert.equal(h.turns[0].error, "network failed");
		if (ending === "EOF") assert.ok(h.turns[0].error);
		assert.equal(h.timers.size, 0);
		assert.deepEqual(
			h.actions.slice(-2).map((action) => action.type),
			["token", "terminal"],
		);
		const snapshot = h.turns;
		staleFlush();
		lateEvents(request.handlers);
		h.lifecycle.cancel();
		assert.equal(h.turns, snapshot);
	});
}

for (const context of ["library", "archived thread"] as const) {
	test(`${context} switch terminalizes the old turn before new work`, async () => {
		const h = harness();
		const old = h.start();
		h.requests[0].handlers.onToken?.("old tail");
		h.lifecycle.cancel();
		assert.equal(h.turns[0].answer, "old tail");
		assert.equal(h.turns[0].cancelled, true);
		assert.equal(
			h.turns.some((turn) => turn.pending),
			false,
		);
		const oldTurn = h.turns[0];
		if (context === "archived thread") {
			h.dispatch({ type: "hydrate", turns: [] });
		}
		const current = h.start(
			"current-turn",
			"other-library",
			context === "archived thread" ? "archive" : undefined,
		);
		lateEvents(h.requests[0].handlers);
		h.requests[0].completion.resolve();
		await old;
		h.requests[1].handlers.onToken?.("current");
		h.tick();
		assert.equal(h.turns.at(-1)?.answer, "current");
		assert.equal(h.turns.at(-1)?.pending, true);
		if (context === "library") assert.equal(h.turns[0], oldTurn);
		h.lifecycle.cancel();
		assert.equal(
			h.turns.some((turn) => turn.pending),
			false,
		);
		assert.equal(h.requests[1].signal.aborted, true);
		h.requests[1].completion.resolve();
		await current;
	});
}

test("metadata can update session and thread identifiers without settling the attempt", async () => {
	const h = harness();
	const running = h.start();
	const request = h.requests[0];
	request.handlers.onMeta?.({
		session_id: "assigned-session",
		thread_id: "assigned-thread",
		mode: "llm",
		refused: false,
	});
	assert.equal(h.session, "assigned-session");
	assert.equal(request.signal.aborted, false);
	assert.equal(h.turns[0].pending, true);
	request.handlers.onToken?.("after metadata");
	h.tick();
	assert.equal(h.turns[0].answer, "after metadata");
	request.handlers.onDone?.(done("after metadata"));
	request.completion.resolve();
	await running;
	assert.equal(
		h.turns.some((turn) => turn.pending),
		false,
	);
});

test("unmount aborts without state writes, and queued callbacks cannot outlive it", async () => {
	const h = harness();
	const running = h.start();
	h.requests[0].handlers.onToken?.("unpainted");
	const staleFlush = [...h.timers.values()][0];
	const snapshot = h.turns;
	h.lifecycle.cancel(false);
	assert.equal(h.requests[0].signal.aborted, true);
	assert.equal(h.timers.size, 0);
	staleFlush();
	lateEvents(h.requests[0].handlers);
	h.requests[0].completion.reject(new Error("unmounted"));
	await running;
	assert.equal(h.turns, snapshot);
});

test("real SSE reader preserves split network Unicode and flushes before done without waiting for EOF", async (t) => {
	const answer = "\u4e2d\u6587 \ud83d\ude80 e\u0301";
	const events = [
		`event: token\ndata: ${JSON.stringify(answer.slice(0, 3))}\n\n`,
		`event: token\ndata: ${JSON.stringify(answer.slice(3))}\n\n`,
		`event: done\ndata: ${JSON.stringify(done(answer))}\n\n`,
	];
	let aborted = false;
	t.mock.method(
		globalThis,
		"fetch",
		async (_url: Parameters<typeof fetch>[0], init: RequestInit) => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					init.signal?.addEventListener("abort", () => {
						aborted = true;
						controller.error(new DOMException("finished", "AbortError"));
					});
					const bytes = new TextEncoder().encode(events.join(""));
					for (let offset = 0; offset < bytes.length; offset += 3) {
						controller.enqueue(bytes.slice(offset, offset + 3));
					}
				},
			});
			return new Response(body);
		},
	);
	const lifecycle = createAskStreamLifecycle(askQuestionStream);
	const painted: string[] = [];
	let completed = false;
	await lifecycle.run(
		{ question: "q", libraryId: "library" },
		{
			onToken: (token) => painted.push(token),
			onDone: (result) => {
				assert.equal(painted.join(""), answer);
				assert.equal(result.answer, answer);
				completed = true;
			},
			onTerminal: () => assert.fail("successful SSE must not become an error"),
		},
	);
	assert.equal(completed, true);
	assert.equal(aborted, true);
	assert.deepEqual(painted, [answer]);
});

test("access-changed SSE error uses message, flushes the tail, and rejects later done", async (t) => {
	const message = "\u8bbf\u95ee\u6743\u9650\u5df2\u53d8\u5316";
	const frames = [
		`event: token\ndata: ${JSON.stringify("received tail")}\n\n`,
		`event: error\ndata: ${JSON.stringify({ code: "ask_access_changed", message, truncated: true })}\n\n`,
		`event: token\ndata: ${JSON.stringify("late")}\n\n`,
		`event: done\ndata: ${JSON.stringify(done("late final"))}\n\n`,
	];
	t.mock.method(globalThis, "fetch", async () => new Response(frames.join("")));
	const lifecycle = createAskStreamLifecycle(askQuestionStream);
	const painted: string[] = [];
	const terminals: { cancelled: boolean; error?: unknown }[] = [];
	let completed = false;
	let tailAtTerminal = "";
	await lifecycle.run(
		{ question: "q", libraryId: "library" },
		{
			onToken: (token) => painted.push(token),
			onDone: () => {
				completed = true;
			},
			onTerminal: (result) => {
				terminals.push(result);
				tailAtTerminal = painted.join("");
			},
		},
	);
	assert.equal(terminals.length, 1);
	assert.equal(terminals[0].cancelled, false);
	assert.ok(terminals[0].error instanceof Error);
	assert.equal(terminals[0].error.message, message);
	assert.equal(tailAtTerminal, "received tail");
	assert.equal(completed, false);
	assert.deepEqual(painted, ["received tail"]);
});

test("completion mapping failure terminalizes instead of silently leaving a pending turn", async () => {
	const cause = new Error("invalid completion payload");
	const terminals: { cancelled: boolean; error?: unknown }[] = [];
	const painted: string[] = [];
	let signal: AbortSignal | undefined;
	const lifecycle = createAskStreamLifecycle(
		async (_input, handlers, requestSignal) => {
			signal = requestSignal;
			handlers.onToken?.("received tail");
			handlers.onDone?.(done());
		},
	);
	await lifecycle.run(
		{ question: "q", libraryId: "library" },
		{
			onToken: (token) => painted.push(token),
			onDone: () => {
				throw cause;
			},
			onTerminal: (result) => terminals.push(result),
		},
	);
	assert.deepEqual(terminals, [{ cancelled: false, error: cause }]);
	assert.deepEqual(painted, ["received tail"]);
	assert.equal(signal?.aborted, true);
});
