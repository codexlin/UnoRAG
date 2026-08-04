import { GET as getMetrics } from "@/app/api/metrics/route";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET(): Response {
	return getMetrics();
}
