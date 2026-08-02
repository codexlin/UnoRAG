import { handlePublicApiV1 } from "@/lib/server/integration-rag";

/**
 * Mode B external retrieve entry (Scheme A).
 * Authorization: Bearer mk_svc_… → scoped native retrieval runtime
 */
export async function POST(request: Request) {
	return handlePublicApiV1({
		request,
		scope: "retrieve",
		target: "/v1/retrieve",
	});
}
