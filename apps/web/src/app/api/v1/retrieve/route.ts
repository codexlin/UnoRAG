import { NextResponse } from "next/server";

import {
	forwardIntegrationRag,
	requireIntegrationServiceKey,
} from "@/lib/server/integration-rag";

/**
 * Mode B external retrieve entry (Scheme A).
 * Authorization: Bearer mk_svc_… → HMAC → FastAPI POST /v1/retrieve
 */
export async function POST(request: Request) {
	const auth = await requireIntegrationServiceKey(request, "retrieve");
	if (!auth.ok) {
		return NextResponse.json({ detail: auth.detail }, { status: auth.status });
	}
	return forwardIntegrationRag({
		request,
		key: auth.key,
		target: "/v1/retrieve",
	});
}
