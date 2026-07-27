import "server-only";

import { createHash, createHmac, randomUUID } from "node:crypto";

import type { AuthIdentity } from "./auth/provider";

export type InternalAuthSource = "session" | "service";

export type InternalRagContext = {
	v: 1;
	iss: "meriknow-control-plane";
	tenant_id: string;
	workspace_id: string;
	principal_id: string;
	group_ids: string[];
	request_id: string;
	jti: string;
	auth_source: InternalAuthSource;
	method: string;
	target: string;
	body_sha256: string | null;
	iat: number;
	exp: number;
};

function base64Url(value: string | Buffer): string {
	return Buffer.from(value).toString("base64url");
}

export type InternalRequestBinding = {
	method: string;
	target: string;
	body?: Uint8Array;
};

export function createInternalRagHeaders(
	binding: InternalRequestBinding,
	identity: AuthIdentity,
	now = Math.floor(Date.now() / 1000),
	options?: { authSource?: InternalAuthSource; requestId?: string },
): Headers {
	const secret = process.env.MERIKNOW_INTERNAL_SECRET?.trim();
	if (!secret || secret.length < 32) {
		throw new Error(
			"MERIKNOW_INTERNAL_SECRET must contain at least 32 characters",
		);
	}

	const requestId = options?.requestId ?? randomUUID();
	const authSource = options?.authSource ?? "session";
	const context: InternalRagContext = {
		v: 1,
		iss: "meriknow-control-plane",
		tenant_id: identity.tenantId,
		workspace_id: identity.workspaceId,
		principal_id: identity.principalId,
		group_ids: identity.groupIds,
		request_id: requestId,
		jti: requestId,
		auth_source: authSource,
		method: binding.method.toUpperCase(),
		target: binding.target,
		body_sha256: binding.body
			? createHash("sha256").update(binding.body).digest("hex")
			: null,
		iat: now,
		exp: now + 60,
	};
	const token = base64Url(JSON.stringify(context));
	const signature = createHmac("sha256", secret)
		.update(token, "utf8")
		.digest("base64url");

	return new Headers({
		"x-meriknow-context": token,
		"x-meriknow-signature": signature,
		"x-request-id": context.request_id,
	});
}
