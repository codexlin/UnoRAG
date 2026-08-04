import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

type TelemetryState = {
	sdk: NodeSDK | null;
	initialized: boolean;
};

type TelemetryEnvironment = Readonly<Record<string, string | undefined>>;

const globalState = globalThis as typeof globalThis & {
	__unoragTelemetry?: TelemetryState;
};

function state(): TelemetryState {
	globalState.__unoragTelemetry ??= { sdk: null, initialized: false };
	return globalState.__unoragTelemetry;
}

export function telemetryConfigured(
	environment: TelemetryEnvironment = process.env,
): boolean {
	if (environment.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true")
		return false;
	return Boolean(
		environment.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
			environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() ||
			environment.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim(),
	);
}

export function tracingConfigured(
	environment: TelemetryEnvironment = process.env,
): boolean {
	if (environment.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true")
		return false;
	return Boolean(
		environment.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
			environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim(),
	);
}

export function initializeTelemetry(
	serviceName: string,
	environment: TelemetryEnvironment = process.env,
): boolean {
	const current = state();
	if (current.initialized) return current.sdk !== null;
	current.initialized = true;
	if (!telemetryConfigured(environment)) return false;

	try {
		const commonEndpoint = environment.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
		const tracesEnabled = Boolean(
			commonEndpoint || environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim(),
		);
		const logsEnabled = Boolean(
			commonEndpoint || environment.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim(),
		);
		const sdk = new NodeSDK({
			resource: resourceFromAttributes({
				"service.name": serviceName,
				"service.namespace": "unorag",
				"service.version": environment.UNORAG_RELEASE_VERSION?.trim() || "dev",
				"deployment.environment.name":
					environment.APP_ENV?.trim() || "development",
			}),
			spanProcessors: tracesEnabled
				? [new BatchSpanProcessor(new OTLPTraceExporter())]
				: [],
			logRecordProcessors: logsEnabled
				? [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })]
				: [],
		});
		sdk.start();
		current.sdk = sdk;
		return true;
	} catch {
		current.sdk = null;
		process.stderr.write(
			`${JSON.stringify({ event: "telemetry.initialization_failed", service: serviceName })}\n`,
		);
		return false;
	}
}

export async function shutdownTelemetry(): Promise<void> {
	const current = state();
	const sdk = current.sdk;
	current.sdk = null;
	if (!sdk) return;
	try {
		const shutdown = sdk.shutdown().then(
			() => true,
			() => false,
		);
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const completed = await Promise.race([
			shutdown,
			new Promise<boolean>((resolve) => {
				timeout = setTimeout(() => resolve(false), 5_000);
				timeout.unref?.();
			}),
		]);
		if (timeout) clearTimeout(timeout);
		if (!completed) throw new Error("telemetry shutdown incomplete");
	} catch {
		process.stderr.write(
			`${JSON.stringify({ event: "telemetry.shutdown_failed" })}\n`,
		);
	}
}
