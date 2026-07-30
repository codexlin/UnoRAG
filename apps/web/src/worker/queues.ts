import type { DurableJobInput } from "./contracts";

export const workerQueueKeys = [
	"ingest-local",
	"ingest-auto",
	"ingest-mineru",
	"lifecycle",
] as const;

export type WorkerQueueKey = (typeof workerQueueKeys)[number];

export const workerQueueNames = {
	"ingest-local": "unorag-ingest-local",
	"ingest-auto": "unorag-ingest-auto",
	"ingest-mineru": "unorag-ingest-mineru",
	lifecycle: "unorag-lifecycle",
} as const satisfies Record<WorkerQueueKey, string>;

export function queueKeyForJob(input: DurableJobInput): WorkerQueueKey {
	if (input.type !== "document.ingest") {
		return "lifecycle";
	}
	switch (input.payload.queue_class) {
		case "local":
			return "ingest-local";
		case "mineru":
			return "ingest-mineru";
		case "auto":
			return "ingest-auto";
	}
}

export function queueNameForJob(input: DurableJobInput): string {
	return workerQueueNames[queueKeyForJob(input)];
}
