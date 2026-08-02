import contract from "../../../../../contracts/public-api-v1.openapi.json";

export const dynamic = "force-static";

export function GET() {
	return Response.json(contract, {
		headers: {
			"cache-control": "public, max-age=300",
			"x-unorag-api-version": "1",
		},
	});
}
