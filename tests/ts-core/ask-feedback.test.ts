import assert from "node:assert/strict";
import test from "node:test";
import {
	type AskFeedbackRecord,
	buildGoldenCaseSkeleton,
	submitAskFeedbackSchema,
	updateFeedbackTriageSchema,
} from "../../src/lib/ask-feedback";
import {
	createAskFeedbackHandlers,
	createWorkspaceFeedbackHandlers,
} from "../../src/server/http/ask-feedback";
import { AskFeedbackNotFoundError } from "../../src/server/observability/ask-feedback-service";

const VALID_REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const VALID_FEEDBACK_ID = "22222222-2222-4222-8222-222222222222";

const BASE_IDENTITY = {
	tenantId: "org-1",
	workspaceId: "ws-1",
	principalId: "user-1",
	role: "admin",
};

function makeJsonRequest(
	url: string,
	method: "POST" | "PATCH",
	body: unknown,
	headers: Record<string, string> = {},
): Request {
	return new Request(url, {
		method,
		headers: {
			"content-type": "application/json",
			origin: "https://unorag.example",
			...headers,
		},
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

test("submitAskFeedbackSchema enforces rating and reason_code rules", () => {
	const upOk = submitAskFeedbackSchema.safeParse({
		request_id: VALID_REQUEST_ID,
		rating: "up",
	});
	assert.equal(upOk.success, true);

	const upWithReason = submitAskFeedbackSchema.safeParse({
		request_id: VALID_REQUEST_ID,
		rating: "up",
		reason_code: "citation_error",
	});
	assert.equal(upWithReason.success, false);

	const downWithReason = submitAskFeedbackSchema.safeParse({
		request_id: VALID_REQUEST_ID,
		rating: "down",
		reason_code: "missing_info",
	});
	assert.equal(downWithReason.success, true);

	const downWithoutReason = submitAskFeedbackSchema.safeParse({
		request_id: VALID_REQUEST_ID,
		rating: "down",
	});
	assert.equal(downWithoutReason.success, true);

	const badUuid = submitAskFeedbackSchema.safeParse({
		request_id: "not-a-uuid",
		rating: "down",
	});
	assert.equal(badUuid.success, false);
});

test("buildGoldenCaseSkeleton builds metadata-only evaluation skeleton", () => {
	const record: AskFeedbackRecord = {
		id: VALID_FEEDBACK_ID,
		request_id: VALID_REQUEST_ID,
		library_id: "lib-1",
		query_type: "factual",
		run_status: "completed",
		refuse_reason: null,
		citation_count: 2,
		latency_ms: 820,
		used_hybrid: true,
		used_rerank: true,
		rating: "down",
		reason_code: "hallucination",
		triage_status: "open",
		created_at: "2026-11-15T00:00:00.000Z",
		updated_at: "2026-11-15T00:00:00.000Z",
	};

	const skeleton = buildGoldenCaseSkeleton(record);
	assert.equal(skeleton.id, "badcase-11111111");
	assert.equal(skeleton.request_id, VALID_REQUEST_ID);
	assert.equal(skeleton.library_id, "lib-1");
	assert.equal(skeleton.question, "");
	assert.equal(skeleton.target_file, "");
	assert.deepEqual(skeleton.key_facts, []);
	assert.equal(skeleton.expect_refusal, true);
});

test("createAskFeedbackHandlers enforces auth, origin, content-type, validation, and scope", async () => {
	let capturedScope: unknown = null;
	let capturedInput: unknown = null;
	let throwNotFound = false;

	const { POST } = createAskFeedbackHandlers({
		appBaseUrl: "https://unorag.example",
		resolveIdentity: async (request) =>
			request.headers.get("x-anon") ? null : BASE_IDENTITY,
		submit: async (scope, input) => {
			capturedScope = scope;
			capturedInput = input;
			if (throwNotFound) {
				throw new AskFeedbackNotFoundError("ask run not found in scope");
			}
			return { id: VALID_FEEDBACK_ID, ...input };
		},
	});

	const unauth = await POST(
		makeJsonRequest(
			"https://unorag.example/api/rag/v1/feedback",
			"POST",
			{ request_id: VALID_REQUEST_ID, rating: "up" },
			{ "x-anon": "1" },
		),
	);
	assert.equal(unauth.status, 401);

	const crossSite = await POST(
		makeJsonRequest(
			"https://unorag.example/api/rag/v1/feedback",
			"POST",
			{ request_id: VALID_REQUEST_ID, rating: "up" },
			{ "sec-fetch-site": "cross-site" },
		),
	);
	assert.equal(crossSite.status, 403);

	const badOrigin = await POST(
		makeJsonRequest(
			"https://unorag.example/api/rag/v1/feedback",
			"POST",
			{ request_id: VALID_REQUEST_ID, rating: "up" },
			{ origin: "https://evil.example" },
		),
	);
	assert.equal(badOrigin.status, 403);

	const badContentType = await POST(
		new Request("https://unorag.example/api/rag/v1/feedback", {
			method: "POST",
			headers: {
				"content-type": "text/plain",
				origin: "https://unorag.example",
			},
			body: "{}",
		}),
	);
	assert.equal(badContentType.status, 415);

	const invalidJson = await POST(
		makeJsonRequest(
			"https://unorag.example/api/rag/v1/feedback",
			"POST",
			"{bad",
		),
	);
	assert.equal(invalidJson.status, 400);

	const invalidSchema = await POST(
		makeJsonRequest("https://unorag.example/api/rag/v1/feedback", "POST", {
			request_id: "bad-id",
			rating: "down",
		}),
	);
	assert.equal(invalidSchema.status, 400);

	throwNotFound = true;
	const notFound = await POST(
		makeJsonRequest("https://unorag.example/api/rag/v1/feedback", "POST", {
			request_id: VALID_REQUEST_ID,
			rating: "down",
			reason_code: "citation_error",
		}),
	);
	assert.equal(notFound.status, 404);

	throwNotFound = false;
	const ok = await POST(
		makeJsonRequest(
			"http://localhost:3000/api/rag/v1/feedback",
			"POST",
			{
				request_id: VALID_REQUEST_ID,
				rating: "down",
				reason_code: "outdated_doc",
			},
			{ host: "127.0.0.1:3001", origin: "http://127.0.0.1:3001" },
		),
	);
	assert.equal(ok.status, 200);
	assert.deepEqual(capturedScope, {
		organizationId: "org-1",
		workspaceId: "ws-1",
		userId: "user-1",
	});
	assert.deepEqual(capturedInput, {
		request_id: VALID_REQUEST_ID,
		rating: "down",
		reason_code: "outdated_doc",
	});
});

test("createWorkspaceFeedbackHandlers enforces member management role, filters, and triage updates", async () => {
	let lastListArgs: unknown = null;
	let throwNotFound = false;

	const { GET, PATCH } = createWorkspaceFeedbackHandlers({
		appBaseUrl: "https://unorag.example",
		resolveIdentity: async (request) => {
			const role = request.headers.get("x-role");
			if (role === "none") return null;
			return { ...BASE_IDENTITY, role: role ?? "admin" };
		},
		list: async (scope, filters) => {
			lastListArgs = { scope, filters };
			return [];
		},
		updateTriage: async (_scope, input) => {
			if (throwNotFound) {
				throw new AskFeedbackNotFoundError("feedback record not found");
			}
			return { id: input.feedback_id, triage_status: input.triage_status };
		},
	});

	const viewerRes = await GET(
		new Request("https://unorag.example/api/workspace/operations/feedback", {
			headers: { "x-role": "viewer" },
		}),
	);
	assert.equal(viewerRes.status, 403);

	const editorRes = await GET(
		new Request("https://unorag.example/api/workspace/operations/feedback", {
			headers: { "x-role": "editor" },
		}),
	);
	assert.equal(editorRes.status, 403);

	const badFilter = await GET(
		new Request(
			"https://unorag.example/api/workspace/operations/feedback?triage_status=bogus",
		),
	);
	assert.equal(badFilter.status, 400);

	const badLimit = await GET(
		new Request(
			"https://unorag.example/api/workspace/operations/feedback?limit=999",
		),
	);
	assert.equal(badLimit.status, 400);

	const okList = await GET(
		new Request(
			"https://unorag.example/api/workspace/operations/feedback?triage_status=open&reason_code=missing_info&limit=25",
		),
	);
	assert.equal(okList.status, 200);
	assert.deepEqual(lastListArgs, {
		scope: { organizationId: "org-1", workspaceId: "ws-1" },
		filters: {
			rating: "down",
			triageStatus: "open",
			reasonCode: "missing_info",
			limit: 25,
		},
	});

	const badPatch = await PATCH(
		makeJsonRequest(
			"https://unorag.example/api/workspace/operations/feedback",
			"PATCH",
			{ feedback_id: "bad", triage_status: "resolved" },
		),
	);
	assert.equal(badPatch.status, 400);

	throwNotFound = true;
	const notFoundPatch = await PATCH(
		makeJsonRequest(
			"https://unorag.example/api/workspace/operations/feedback",
			"PATCH",
			{ feedback_id: VALID_FEEDBACK_ID, triage_status: "resolved" },
		),
	);
	assert.equal(notFoundPatch.status, 404);

	throwNotFound = false;
	const okPatch = await PATCH(
		makeJsonRequest(
			"https://unorag.example/api/workspace/operations/feedback",
			"PATCH",
			{ feedback_id: VALID_FEEDBACK_ID, triage_status: "exported" },
		),
	);
	assert.equal(okPatch.status, 200);
	const triageCheck = updateFeedbackTriageSchema.safeParse({
		feedback_id: VALID_FEEDBACK_ID,
		triage_status: "exported",
	});
	assert.equal(triageCheck.success, true);
});
