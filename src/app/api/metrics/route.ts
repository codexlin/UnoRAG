import { renderPrometheusMetrics } from "@/server/observability/metrics";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET(): Response {
	return new Response(renderPrometheusMetrics(), {
		status: 200,
		headers: {
			"cache-control": "no-store, max-age=0",
			"content-type": "text/plain; version=0.0.4; charset=utf-8",
			"x-content-type-options": "nosniff",
		},
	});
}
