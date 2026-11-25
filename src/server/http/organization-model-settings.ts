import {
	ModelConnectionTestRequestSchema,
	type ModelConnectionTestResult,
	type OrganizationModelSettingsView,
} from "@/lib/model-settings";
import { isSameOriginSessionRequest } from "@/lib/server/auth/same-origin";
import { canManageOrganizationModels } from "@/lib/server/organization-permissions.mjs";
import type { RateLimitResult } from "@/lib/server/security/fixed-window-rate-limit";

const MAX_REQUEST_BODY_BYTES = 64 * 1024;

type Identity = {
	tenantId: string;
	workspaceId: string;
	principalId: string;
	organizationRole: string;
};

type Dependencies = {
	resolveIdentity(request: Request): Promise<Identity | null>;
	read(organizationId: string): Promise<OrganizationModelSettingsView>;
	patch(input: {
		organizationId: string;
		workspaceId?: string | null;
		patch: unknown;
		updatedBy: string;
		expectedPolicyVersion?: number;
		requestId?: string | null;
		ipAddress?: string | null;
		userAgent?: string | null;
	}): Promise<
		| { ok: true; view: OrganizationModelSettingsView }
		| { ok: false; status: number; detail: string; code?: string }
	>;
	testConnection(input: {
		organizationId: string;
		request: ReturnType<typeof ModelConnectionTestRequestSchema.parse>;
	}): Promise<
		| { ok: true; result: ModelConnectionTestResult }
		| { ok: false; status: number; detail: string; code?: string }
	>;
	checkProbeRateLimit?: (input: {
		organizationId: string;
		principalId: string;
	}) => Promise<RateLimitResult>;
	appBaseUrl?: string;
};

function json(body: unknown, init?: ResponseInit) {
	const headers = new Headers(init?.headers);
	headers.set("cache-control", "private, no-store");
	return Response.json(body, {
		...init,
		headers,
	});
}

function isJsonContentType(request: Request): boolean {
	return /^application\/json(?:\s*;|$)/i.test(
		request.headers.get("content-type") ?? "",
	);
}

async function readBoundedJsonBody(
	request: Request,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
	if (!isJsonContentType(request)) {
		return {
			ok: false,
			response: json({ detail: "application/json required" }, { status: 415 }),
		};
	}
	const contentLength = Number(request.headers.get("content-length") ?? "");
	if (
		Number.isFinite(contentLength) &&
		contentLength > MAX_REQUEST_BODY_BYTES
	) {
		return {
			ok: false,
			response: json({ detail: "request body too large" }, { status: 413 }),
		};
	}
	const reader = request.body?.getReader();
	if (!reader) {
		return {
			ok: false,
			response: json({ detail: "invalid JSON body" }, { status: 400 }),
		};
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_REQUEST_BODY_BYTES) {
				await reader.cancel().catch(() => undefined);
				return {
					ok: false,
					response: json({ detail: "request body too large" }, { status: 413 }),
				};
			}
			chunks.push(value);
		}
		const merged = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return {
			ok: true,
			body: JSON.parse(new TextDecoder().decode(merged)),
		};
	} catch {
		return {
			ok: false,
			response: json({ detail: "invalid JSON body" }, { status: 400 }),
		};
	} finally {
		reader.releaseLock();
	}
}

function requestMetadata(request: Request) {
	const forwarded = request.headers
		.get("x-forwarded-for")
		?.split(",")[0]
		?.trim();
	const realIp = request.headers.get("x-real-ip")?.trim();
	return {
		requestId: request.headers.get("x-request-id")?.trim() || null,
		ipAddress: forwarded || realIp || null,
		userAgent: request.headers.get("user-agent")?.slice(0, 256) || null,
	};
}

export function createOrganizationModelSettingsHandlers(deps: Dependencies) {
	async function readSettings(request: Request) {
		try {
			const identity = await deps.resolveIdentity(request);
			if (!identity) {
				return json({ detail: "authentication required" }, { status: 401 });
			}
			if (!canManageOrganizationModels(identity)) {
				return json({ detail: "forbidden" }, { status: 403 });
			}
			const view = await deps.read(identity.tenantId);
			return json(view);
		} catch {
			return json(
				{
					detail: "model settings service temporarily unavailable",
					code: "service_unavailable",
				},
				{ status: 503 },
			);
		}
	}

	async function updateSettings(request: Request) {
		try {
			const identity = await deps.resolveIdentity(request);
			if (!identity) {
				return json({ detail: "authentication required" }, { status: 401 });
			}
			if (!canManageOrganizationModels(identity)) {
				return json({ detail: "forbidden" }, { status: 403 });
			}
			if (!isSameOriginSessionRequest(request, deps.appBaseUrl)) {
				return json({ detail: "forbidden" }, { status: 403 });
			}
			const parsedBody = await readBoundedJsonBody(request);
			if (!parsedBody.ok) return parsedBody.response;
			const rawBody = parsedBody.body;
			if (
				typeof rawBody !== "object" ||
				rawBody === null ||
				Array.isArray(rawBody)
			) {
				return json(
					{ detail: "request body must be an object" },
					{ status: 400 },
				);
			}
			const body = rawBody as { models?: unknown; policy_version?: unknown };
			let expectedPolicyVersion: number | undefined;
			if (body.policy_version !== undefined) {
				if (
					typeof body.policy_version !== "number" ||
					!Number.isSafeInteger(body.policy_version) ||
					body.policy_version < 1
				) {
					return json(
						{
							detail: "policy_version must be a positive integer",
							code: "invalid_version",
						},
						{ status: 400 },
					);
				}
				expectedPolicyVersion = body.policy_version;
			}
			const meta = requestMetadata(request);
			const result = await deps.patch({
				organizationId: identity.tenantId,
				workspaceId: identity.workspaceId,
				patch: body.models,
				updatedBy: identity.principalId,
				expectedPolicyVersion,
				...meta,
			});
			if (!result.ok) {
				return json(
					{
						detail: result.detail,
						...(result.code ? { code: result.code } : {}),
					},
					{ status: result.status },
				);
			}
			return json(result.view);
		} catch {
			return json(
				{
					detail: "model settings service temporarily unavailable",
					code: "service_unavailable",
				},
				{ status: 503 },
			);
		}
	}

	async function testSettings(request: Request) {
		try {
			const identity = await deps.resolveIdentity(request);
			if (!identity) {
				return json({ detail: "authentication required" }, { status: 401 });
			}
			if (!canManageOrganizationModels(identity)) {
				return json({ detail: "forbidden" }, { status: 403 });
			}
			if (!isSameOriginSessionRequest(request, deps.appBaseUrl)) {
				return json({ detail: "forbidden" }, { status: 403 });
			}
			if (deps.checkProbeRateLimit) {
				const rate = await deps.checkProbeRateLimit({
					organizationId: identity.tenantId,
					principalId: identity.principalId,
				});
				if (!rate.ok) {
					return json(
						{
							detail: "too many connection probes; please retry later",
							code: "rate_limited",
						},
						{
							status: 429,
							headers: { "retry-after": String(rate.retryAfterSeconds) },
						},
					);
				}
			}
			const parsedBody = await readBoundedJsonBody(request);
			if (!parsedBody.ok) return parsedBody.response;
			const parsed = ModelConnectionTestRequestSchema.safeParse(
				parsedBody.body,
			);
			if (!parsed.success) {
				return json(
					{
						detail:
							parsed.error.issues[0]?.message ??
							"invalid connection test input",
					},
					{ status: 400 },
				);
			}
			const outcome = await deps.testConnection({
				organizationId: identity.tenantId,
				request: parsed.data,
			});
			if (!outcome.ok) {
				return json(
					{
						detail: outcome.detail,
						...(outcome.code ? { code: outcome.code } : {}),
					},
					{ status: outcome.status },
				);
			}
			return json(outcome.result);
		} catch {
			return json(
				{
					detail: "model connection test temporarily unavailable",
					code: "service_unavailable",
				},
				{ status: 503 },
			);
		}
	}

	return { GET: readSettings, PATCH: updateSettings, POST_TEST: testSettings };
}
