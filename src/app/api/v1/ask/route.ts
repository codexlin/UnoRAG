import { handlePublicApiV1 } from "@/lib/server/integration-rag";

/**
 * Mode B external ask entry (Scheme A).
 * Authorization: Bearer mk_svc_… → scoped native Ask runtime
 */
export async function POST(request: Request) {
	return handlePublicApiV1({
		request,
		scope: "ask",
		target: "/v1/ask",
		injectAskOverrides: true,
	});
}
