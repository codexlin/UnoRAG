import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
	adaptCapturedLiveReportForRagas,
	RagasSampleSchema,
	serializeRagasJsonl,
} from "../../src/evaluation/ragas-export";
import { writePrivateEvaluationArtifact } from "../../src/evaluation/sensitive-capture";

export async function exportCapturedLiveReport(
	report: unknown,
	captureDirectory: string,
	root = process.cwd(),
): Promise<string> {
	const selection = z
		.object({
			run_id: z.string().regex(/^[a-zA-Z0-9_.:-]{1,160}$/),
			positive_cases: z
				.array(
					z.object({
						response: z.object({
							requestId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,160}$/),
						}),
					}),
				)
				.min(1)
				.max(100),
		})
		.safeParse(report);
	if (!selection.success)
		throw new Error("invalid live report capture selection");
	const captures: unknown[] = [];
	const generations: unknown[] = [];
	for (const row of selection.data.positive_cases) {
		for (const [prefix, target] of [
			["capture", captures],
			["generation", generations],
		] as const) {
			const file = await open(
				resolve(captureDirectory, `${prefix}-${row.response.requestId}.json`),
				constants.O_RDONLY | constants.O_NOFOLLOW,
			).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return null;
				throw new Error("cannot read private capture");
			});
			if (!file) continue;
			try {
				const info = await file.stat();
				if (
					!info.isFile() ||
					info.size > 8_000_000 ||
					(info.mode & 0o077) !== 0
				)
					throw new Error("capture must be a bounded private regular file");
				target.push(JSON.parse(await file.readFile("utf8")));
			} finally {
				await file.close();
			}
		}
	}
	const rows = adaptCapturedLiveReportForRagas(
		report,
		captures,
		true,
		generations,
	);
	return writePrivateEvaluationArtifact(
		`ragas-${selection.data.run_id}.jsonl`,
		serializeRagasJsonl(rows),
		root,
	);
}

async function main(args: string[]): Promise<void> {
	if (args.length === 1 && args[0] === "--schema") {
		process.stdout.write(
			`${JSON.stringify(z.toJSONSchema(RagasSampleSchema), null, 2)}\n`,
		);
		return;
	}
	if (args.length !== 3 || args[0] !== "--allow-sensitive-export")
		throw new Error(
			"usage: export-live.ts --allow-sensitive-export REPORT_JSON CAPTURE_DIRECTORY",
		);
	const info = await open(args[1], constants.O_RDONLY | constants.O_NOFOLLOW);
	let report: unknown;
	try {
		if ((await info.stat()).size > 32_000_000)
			throw new Error("live report too large");
		report = JSON.parse(await info.readFile("utf8"));
	} finally {
		await info.close();
	}
	await exportCapturedLiveReport(report, args[2]);
	process.stdout.write(
		"Private Ragas input exported to .unorag/evaluation. No judge called.\n",
	);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main(process.argv.slice(2)).catch(() => {
		process.stderr.write(
			"Evaluation export failed; check opt-in, private captures, and matching successful live report.\n",
		);
		process.exitCode = 2;
	});
}
