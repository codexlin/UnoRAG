const FUNCTION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** AI SDK telemetry is always metadata-only in the standard product. */
export function metadataOnlyAiTelemetry(functionId: string) {
	if (!FUNCTION_ID_PATTERN.test(functionId)) {
		throw new Error("AI telemetry function ID is invalid");
	}
	return {
		isEnabled: true as const,
		recordInputs: false as const,
		recordOutputs: false as const,
		functionId,
	};
}
