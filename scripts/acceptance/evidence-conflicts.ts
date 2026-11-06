import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
	createAiProviderRegistry,
	judgeAiConfigFromEnv,
} from "../../src/core/ai/provider-registry";
import { getPrompt } from "../../src/core/ai/prompt-registry";
import {
	StructuredOutputAdapter,
	getStructuredFailureMetadata,
} from "../../src/core/ai/structured-output";
import { validateConflictEvidence } from "../../src/core/ask-graph/evidence-conflict";

const FixtureSchema = z
	.object({
		contract_version: z.literal(1),
		description: z.string(),
		cases: z
			.array(
				z
					.object({
						id: z.string().min(1),
						question: z.string().min(1),
						expect_conflict: z.boolean(),
						citations: z
							.array(
								z
									.object({ id: z.string().min(1), text: z.string().min(1) })
									.strict(),
							)
							.min(1)
							.max(6),
					})
					.strict(),
			)
			.min(1)
			.max(20),
	})
	.strict();

type ControlCase = z.infer<typeof FixtureSchema>["cases"][number];
const fixtureUrl = new URL(
	"../../testdata/business/evidence-conflicts.json",
	import.meta.url,
);

export async function* runEvidenceConflictChecks(
	adapter: Pick<StructuredOutputAdapter, "judgeWithMetadata">,
	cases: ControlCase[],
	rounds: number,
) {
	if (!Number.isInteger(rounds) || rounds < 1 || rounds > 3)
		throw new Error("rounds must be 1..3");
	const validated = FixtureSchema.parse({
		contract_version: 1,
		description: "controls",
		cases,
	}).cases;
	for (let round = 1; round <= rounds; round++)
		for (const item of validated) {
			try {
				const result = await adapter.judgeWithMetadata({
					question: item.question,
					citations: item.citations,
					attempts: 1,
				});
				const excerpts = validateConflictEvidence(
					result.output.conflict_evidence,
					item.citations,
				);
				const ok =
					result.output.sufficient &&
					result.output.action === "generate" &&
					excerpts.length > 0 === item.expect_conflict;
				yield { round, case_id: item.id, ok, result, error: null };
			} catch (error) {
				yield {
					round,
					case_id: item.id,
					ok: false,
					result: null,
					error: getStructuredFailureMetadata(error) ?? {
						category: "validation_or_request_failed",
					},
				};
			}
		}
}

async function main() {
	const { values } = parseArgs({
		options: {
			plan: { type: "boolean" },
			"allow-external-judge": { type: "boolean" },
			rounds: { type: "string", default: "2" },
		},
	});
	const rounds = Number(values.rounds);
	if (!Number.isInteger(rounds) || rounds < 1 || rounds > 3)
		throw new Error("rounds must be 1..3");
	const bytes = await readFile(fixtureUrl);
	const fixture = FixtureSchema.parse(JSON.parse(bytes.toString("utf8")));
	const plan = {
		kind: "fixed-evidence-judge-controls",
		contract_version: fixture.contract_version,
		fixture_sha256: createHash("sha256").update(bytes).digest("hex"),
		prompt_digest: getPrompt("judge").digest,
		cases: fixture.cases.length,
		rounds,
		max_http_attempts: fixture.cases.length * rounds * 2,
		max_output_tokens: 1024,
	};
	if (values.plan) {
		console.log(JSON.stringify(plan, null, 2));
		return;
	}
	if (
		process.env.UNORAG_ACCEPT_JUDGE_CONTROLS !== "YES" ||
		!values["allow-external-judge"]
	) {
		throw new Error(
			"Requires UNORAG_ACCEPT_JUDGE_CONTROLS=YES and --allow-external-judge",
		);
	}
	const registry = createAiProviderRegistry(judgeAiConfigFromEnv());
	const adapter = new StructuredOutputAdapter(registry.model, undefined, {
		timeoutMs: 15000,
		maxAttempts: 2,
		maxOutputTokens: 1024,
	});
	const directory = resolve(".unorag/acceptance");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const file = resolve(directory, `judge-controls-${randomUUID()}.json`);
	const rows: unknown[] = [];
	const report = {
		...plan,
		model: registry.modelId,
		started_at: new Date().toISOString(),
		rows,
		result: "RUNNING",
	};
	const save = () =>
		writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
	await save();
	let failed = false;
	for await (const row of runEvidenceConflictChecks(
		adapter,
		fixture.cases,
		rounds,
	)) {
		rows.push(row);
		failed ||= !row.ok;
		await save();
		console.log(
			JSON.stringify({ round: row.round, case_id: row.case_id, ok: row.ok }),
		);
	}
	report.result = failed ? "FAIL" : "PASS";
	await save();
	console.log(JSON.stringify({ result: report.result, report: file }));
	process.exitCode = failed ? 1 : 0;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	main().catch(() => {
		console.error(
			"Judge controls blocked; check consent, configuration and private report.",
		);
		process.exitCode = 2;
	});
}
