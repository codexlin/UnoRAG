import { loadWorkerConfig } from "./config";
import { durableJobSchema } from "./contracts";
import { enqueueDbosJob, shutdownDbos } from "./dbos-runtime";
import type { WorkerPorts } from "./ports";

const enqueueOnlyPorts: WorkerPorts = {
	generationCleanup: {
		async deleteGeneration() {
			throw new Error("enqueue process must not execute workflows");
		},
	},
	transactions: {
		async markGenerationSweeping() {
			throw new Error("enqueue process must not execute workflows");
		},
		async markGenerationDeleted() {
			throw new Error("enqueue process must not execute workflows");
		},
		async markGenerationError() {
			throw new Error("enqueue process must not execute workflows");
		},
	},
};

async function readInput(): Promise<unknown> {
	const payloadIndex = process.argv.indexOf("--payload");
	if (payloadIndex >= 0) {
		const value = process.argv[payloadIndex + 1];
		if (!value) {
			throw new Error("--payload requires a JSON value");
		}
		return JSON.parse(value);
	}
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	const raw = Buffer.concat(chunks).toString("utf8");
	if (!raw.trim()) {
		throw new Error("Provide a job as --payload JSON or on stdin");
	}
	return JSON.parse(raw);
}

async function main(): Promise<void> {
	const config = loadWorkerConfig();
	const input = durableJobSchema.parse(await readInput());
	try {
		const result = await enqueueDbosJob(config, enqueueOnlyPorts, input);
		process.stdout.write(`${JSON.stringify(result)}\\n`);
	} finally {
		await shutdownDbos();
	}
}

main().catch(async (error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`DBOS enqueue failed: ${message}\\n`);
	await shutdownDbos();
	process.exitCode = 1;
});
