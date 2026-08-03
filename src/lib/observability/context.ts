import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type ObservabilityContext = Readonly<{
	requestId?: string;
	otelTraceId?: string;
	organizationId?: string;
	workspaceId?: string;
	principalId?: string;
	jobId?: string;
	workflowId?: string;
}>;

const contextStorage = new AsyncLocalStorage<ObservabilityContext>();

function definedContext(context: ObservabilityContext): Record<string, string> {
	return Object.fromEntries(
		Object.entries(context).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
}

/** Runs work with an immutable context, inheriting fields from the current scope. */
export function runWithObservabilityContext<T>(
	context: ObservabilityContext,
	callback: () => T,
): T {
	const inherited = contextStorage.getStore();
	const scope = Object.freeze({
		...inherited,
		...definedContext(context),
	});
	return contextStorage.run(scope, callback);
}

/** Returns the context for the current asynchronous execution scope, if any. */
export function getObservabilityContext(): ObservabilityContext | undefined {
	return contextStorage.getStore();
}

/** Accept only UUID request IDs from callers; otherwise create a trusted ID. */
export function resolveRequestId(candidate?: string | null): string {
	const value = candidate?.trim();
	return value &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			value,
		)
		? value.toLowerCase()
		: randomUUID();
}
