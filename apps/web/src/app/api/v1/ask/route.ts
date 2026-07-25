import { NextResponse } from "next/server";

import {
	forwardIntegrationRag,
	requireIntegrationServiceKey,
} from "@/lib/server/integration-rag";

/**
 * Mode B external ask entry (Scheme A).
 * Authorization: Bearer mk_svc_… → HMAC → FastAPI POST /v1/ask
 */
export async function POST(request: Request) {
	const auth = await requireIntegrationServiceKey(request, "ask");
	if (!auth.ok) {
		return NextResponse.json({ detail: auth.detail }, { status: auth.status });
	}
	return forwardIntegrationRag({
		request,
		key: auth.key,
		target: "/v1/ask",
		injectAskOverrides: true,
	});
}
