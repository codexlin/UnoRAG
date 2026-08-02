import { proxyRagRequest } from "@/lib/server/rag-proxy";

type RagRouteContext = {
	params: Promise<{ path: string[] }>;
};

async function handler(
	request: Request,
	context: RagRouteContext,
): Promise<Response> {
	const { path } = await context.params;
	return proxyRagRequest(request, path);
}

export const dynamic = "force-dynamic";

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const HEAD = handler;
export const OPTIONS = handler;
