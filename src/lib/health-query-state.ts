export type TimedHealthProbe<T> = {
	payload: T;
	probedAt: number;
	probeMs: number;
};

export class HealthProbeError extends Error {
	constructor(
		message: string,
		readonly probedAt: number,
		readonly probeMs: number,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name =
			options?.cause instanceof Error && options.cause.name === "AbortError"
				? "AbortError"
				: "HealthProbeError";
	}
}

export async function runTimedHealthProbe<T>(
	load: () => Promise<T>,
): Promise<TimedHealthProbe<T>> {
	const started = performance.now();
	try {
		const payload = await load();
		return {
			payload,
			probedAt: Date.now(),
			probeMs: Math.round(performance.now() - started),
		};
	} catch (error) {
		throw new HealthProbeError(
			error instanceof Error ? error.message : "health unavailable",
			Date.now(),
			Math.round(performance.now() - started),
			{ cause: error },
		);
	}
}

export function resolveHealthQueryState<T>(input: {
	data: TimedHealthProbe<T> | undefined;
	error: Error | null;
	isAvailable: (payload: T) => boolean;
}) {
	const health = input.data?.payload ?? null;
	const failedProbe =
		input.error instanceof HealthProbeError ? input.error : null;
	return {
		health,
		error: input.error?.message ?? null,
		apiReady:
			input.error === null && health !== null && input.isAvailable(health),
		healthProbedAt: failedProbe?.probedAt ?? input.data?.probedAt ?? null,
		healthProbeMs: failedProbe?.probeMs ?? input.data?.probeMs ?? null,
	};
}
