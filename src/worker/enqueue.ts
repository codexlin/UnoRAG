import { loadWorkerConfig } from "./config";
import { durableJobSchema } from "./contracts";
import { enqueueDbosJob } from "./dbos-runtime";

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
	const result = await enqueueDbosJob(config, input);
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`DBOS enqueue failed: ${message}\n`);
	process.exitCode = 1;
});
