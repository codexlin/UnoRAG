export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	const { initializeTelemetry } = await import("./lib/observability/telemetry");
	initializeTelemetry(process.env.OTEL_SERVICE_NAME?.trim() || "unorag-web");
}
