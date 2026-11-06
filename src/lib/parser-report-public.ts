/** Content-bearing retrieval metadata is not an operational diagnostic. */
export function publicParserReport(
	input: unknown,
): Record<string, unknown> | null {
	if (!input || typeof input !== "object" || Array.isArray(input)) return null;
	const report = { ...(input as Record<string, unknown>) };
	if (
		report.metrics &&
		typeof report.metrics === "object" &&
		!Array.isArray(report.metrics)
	) {
		const metrics = { ...(report.metrics as Record<string, unknown>) };
		delete metrics.document_context;
		report.metrics = metrics;
	}
	return report;
}
