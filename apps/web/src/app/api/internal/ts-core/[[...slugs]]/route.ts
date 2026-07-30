import { createCharacterizationApp } from "@/server/http/characterization-app";

const app = createCharacterizationApp();

function isEnabled(): boolean {
	return (
		process.env.NODE_ENV !== "production" &&
		process.env.UNORAG_TS_CORE_CHARACTERIZATION === "true"
	);
}

async function handler(request: Request): Promise<Response> {
	if (!isEnabled()) {
		return Response.json(
			{ error: { code: "not_found", message: "Not found" } },
			{ status: 404 },
		);
	}
	return app.handle(request);
}

export const dynamic = "force-dynamic";

export const GET = handler;
export const POST = handler;
