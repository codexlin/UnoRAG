import {
	ASK_FEEDBACK_RATINGS,
	ASK_FEEDBACK_REASON_CODES,
	ASK_FEEDBACK_TRIAGE_STATUSES,
	type AskFeedbackRating,
	type AskFeedbackReasonCode,
	type AskFeedbackRecord,
	type AskFeedbackTriageStatus,
	type SubmitAskFeedbackInput,
	submitAskFeedbackSchema,
	type UpdateFeedbackTriageInput,
	updateFeedbackTriageSchema,
} from "../../lib/ask-feedback";
import { canManageMembers } from "../../lib/server/workspace-permissions.mjs";
import {
	AskFeedbackNotFoundError,
	type AskFeedbackUserScope,
	type AskFeedbackWorkspaceScope,
	type ListAskFeedbackFilters,
} from "../observability/ask-feedback-service";

type SessionIdentity = {
	tenantId: string;
	workspaceId: string;
	principalId: string;
	role: string;
};

function json(body: unknown, status = 200): Response {
	return Response.json(body, {
		status,
		headers: { "cache-control": "private, no-store" },
	});
}

function assertSameOriginMutation(
	request: Request,
	appBaseUrl?: string,
): Response | null {
	if (request.headers.get("sec-fetch-site") === "cross-site") {
		return json({ detail: "forbidden" }, 403);
	}
	const origin = request.headers.get("origin");
	if (origin) {
		try {
			if (origin !== new URL(appBaseUrl ?? request.url).origin) {
				return json({ detail: "forbidden" }, 403);
			}
		} catch {
			return json({ detail: "forbidden" }, 403);
		}
	}
	if (
		!/^application\/json(?:\s*;|$)/i.test(
			request.headers.get("content-type") ?? "",
		)
	) {
		return json({ detail: "application/json required" }, 415);
	}
	return null;
}

async function readJsonBody(request: Request): Promise<unknown> {
	const reader = request.body?.getReader();
	if (!reader) throw new Error("invalid JSON");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 4_096) {
				await reader.cancel();
				return json({ detail: "request body too large" }, 413);
			}
			chunks.push(value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return JSON.parse(new TextDecoder().decode(bytes));
	} finally {
		reader.releaseLock();
	}
}

export function createAskFeedbackHandlers(deps: {
	resolveIdentity(request: Request): Promise<SessionIdentity | null>;
	submit(
		scope: AskFeedbackUserScope,
		input: SubmitAskFeedbackInput,
	): Promise<unknown>;
	appBaseUrl?: string;
}) {
	async function handlePost(request: Request): Promise<Response> {
		const identity = await deps.resolveIdentity(request);
		if (!identity) return json({ detail: "authentication required" }, 401);

		const originError = assertSameOriginMutation(request, deps.appBaseUrl);
		if (originError) return originError;

		let body: unknown;
		try {
			body = await readJsonBody(request);
		} catch {
			return json({ detail: "invalid JSON body" }, 400);
		}
		if (body instanceof Response) return body;

		const parsed = submitAskFeedbackSchema.safeParse(body);
		if (!parsed.success) {
			return json(
				{
					detail: parsed.error.issues[0]?.message ?? "invalid feedback payload",
				},
				400,
			);
		}

		try {
			const feedback = await deps.submit(
				{
					organizationId: identity.tenantId,
					workspaceId: identity.workspaceId,
					userId: identity.principalId,
				},
				parsed.data,
			);
			return json({ feedback });
		} catch (error) {
			if (error instanceof AskFeedbackNotFoundError) {
				return json({ detail: error.message }, 404);
			}
			return json({ detail: "feedback service unavailable" }, 503);
		}
	}

	return { POST: handlePost };
}

function parseFilterParam<const T extends readonly string[]>(
	value: string | null,
	allowed: T,
): T[number] | undefined | null {
	if (!value) return undefined;
	return allowed.includes(value) ? (value as T[number]) : null;
}

export function createWorkspaceFeedbackHandlers(deps: {
	resolveIdentity(request: Request): Promise<SessionIdentity | null>;
	list(
		scope: AskFeedbackWorkspaceScope,
		filters: ListAskFeedbackFilters,
	): Promise<AskFeedbackRecord[]>;
	updateTriage(
		scope: AskFeedbackWorkspaceScope,
		input: UpdateFeedbackTriageInput,
	): Promise<unknown>;
	appBaseUrl?: string;
}) {
	async function handleGet(request: Request): Promise<Response> {
		const identity = await deps.resolveIdentity(request);
		if (!identity) return json({ detail: "authentication required" }, 401);
		if (!canManageMembers(identity)) {
			return json({ detail: "forbidden" }, 403);
		}

		const params = new URL(request.url).searchParams;
		const rating = parseFilterParam(
			params.get("rating") ?? "down",
			ASK_FEEDBACK_RATINGS,
		);
		const triageStatus = parseFilterParam(
			params.get("triage_status"),
			ASK_FEEDBACK_TRIAGE_STATUSES,
		);
		const reasonCode = parseFilterParam(
			params.get("reason_code"),
			ASK_FEEDBACK_REASON_CODES,
		);
		if (rating === null || triageStatus === null || reasonCode === null) {
			return json({ detail: "invalid feedback query filter" }, 400);
		}
		const limitParam = params.get("limit");
		const limit = limitParam ? Number(limitParam) : undefined;
		if (
			limit !== undefined &&
			(!Number.isInteger(limit) || limit < 1 || limit > 200)
		) {
			return json({ detail: "invalid limit" }, 400);
		}

		try {
			const items = await deps.list(
				{
					organizationId: identity.tenantId,
					workspaceId: identity.workspaceId,
				},
				{
					rating: rating as AskFeedbackRating | undefined,
					triageStatus: triageStatus as AskFeedbackTriageStatus | undefined,
					reasonCode: reasonCode as AskFeedbackReasonCode | undefined,
					limit,
				},
			);
			return json({ items });
		} catch {
			return json({ detail: "feedback records unavailable" }, 503);
		}
	}

	async function handlePatch(request: Request): Promise<Response> {
		const identity = await deps.resolveIdentity(request);
		if (!identity) return json({ detail: "authentication required" }, 401);
		if (!canManageMembers(identity)) {
			return json({ detail: "forbidden" }, 403);
		}

		const originError = assertSameOriginMutation(request, deps.appBaseUrl);
		if (originError) return originError;

		let body: unknown;
		try {
			body = await readJsonBody(request);
		} catch {
			return json({ detail: "invalid JSON body" }, 400);
		}
		if (body instanceof Response) return body;

		const parsed = updateFeedbackTriageSchema.safeParse(body);
		if (!parsed.success) {
			return json(
				{ detail: parsed.error.issues[0]?.message ?? "invalid triage payload" },
				400,
			);
		}

		try {
			const feedback = await deps.updateTriage(
				{
					organizationId: identity.tenantId,
					workspaceId: identity.workspaceId,
				},
				parsed.data,
			);
			return json({ feedback });
		} catch (error) {
			if (error instanceof AskFeedbackNotFoundError) {
				return json({ detail: error.message }, 404);
			}
			return json({ detail: "feedback update unavailable" }, 503);
		}
	}

	return { GET: handleGet, PATCH: handlePatch };
}
