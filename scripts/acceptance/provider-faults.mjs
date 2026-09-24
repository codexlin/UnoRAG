import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	EXIT_BLOCKED,
	parseArguments,
	requireEnvironment,
	runCommand,
	waitForReady,
	writeEvidence,
} from "./lib/runtime.mjs";
import {
	cleanupProbe,
	deleteLibraryAndWait,
	ProductSession,
	seedProbe,
	verifyProbe,
	waitForJob,
} from "./recovery-probe.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const composeDirectory = resolve(root, "deploy/compose");
const overlay = resolve(
	composeDirectory,
	"docker-compose.acceptance-faults.yml",
);
const allowedModes = new Set([
	"pass",
	"401",
	"429",
	"503",
	"timeout",
	"malformed",
]);

function quote(value) {
	return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function assertMode(value) {
	if (!allowedModes.has(value))
		throw new Error(`unsupported fault mode ${value}`);
	return value;
}

async function main() {
	const args = parseArguments(process.argv.slice(2));
	const baseUrl = String(
		args["base-url"] || process.env.UNORAG_BASE_URL || "http://localhost:3000",
	).replace(/\/$/, "");
	const email = String(
		args.email || process.env.UNORAG_ADMIN_EMAIL || "admin@unorag.local",
	);
	const passwordEnv = String(args["password-env"] || "UNORAG_ADMIN_PASSWORD");
	const password = process.env[passwordEnv];
	const outputDirectory = resolve(
		String(args["output-dir"] || "scripts/acceptance/.provider-faults-work"),
	);
	const mineruFixture = args["mineru-fixture"]
		? resolve(String(args["mineru-fixture"]))
		: null;
	const plan = {
		base_url: baseUrl,
		faults: [
			"llm:401",
			"llm:429",
			"llm:503",
			"embedding:timeout",
			"embedding:401",
		],
		mineru_fault: mineruFixture
			? `mineru:401 (${basename(mineruFixture)})`
			: "not requested",
		invariants: [
			"bounded failure",
			"no fabricated answer",
			"old active survives failed replace",
			"recovery succeeds",
		],
	};
	if (args.plan === true) {
		console.log(JSON.stringify(plan, null, 2));
		return 0;
	}
	requireEnvironment("UNORAG_ACCEPT_PROVIDER_FAULTS", "YES");
	if (!password) {
		const error = new Error(`${passwordEnv} is required`);
		error.exitCode = EXIT_BLOCKED;
		throw error;
	}

	const token = randomBytes(32).toString("hex");
	const composeEnv = {
		UNORAG_COMPOSE_BUILTIN_OVERLAY: overlay,
		UNORAG_FAULT_PROVIDER_CONTROL_TOKEN: token,
	};
	const report = {
		schema_version: 1,
		name: "UnoRAG Provider fault and idempotent recovery acceptance",
		started_at: new Date().toISOString(),
		git_revision: process.env.GITHUB_SHA || "local",
		plan,
		stages: [],
		result: "FAIL",
	};
	let probe;
	let overlayStarted = false;
	const stage = async (name, action) => {
		const started = performance.now();
		try {
			const detail = await action();
			report.stages.push({
				name,
				status: "PASS",
				duration_ms: Math.round(performance.now() - started),
				detail: detail ?? "ok",
			});
			return detail;
		} catch (error) {
			report.stages.push({
				name,
				status: "FAIL",
				duration_ms: Math.round(performance.now() - started),
				detail: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	};
	const compose = async (name, command, timeoutMs = 300_000) => {
		const result = await runCommand({
			command: "bash",
			args: ["-lc", `source scripts/compose-env.sh; ${command}`],
			cwd: composeDirectory,
			env: composeEnv,
			logPath: resolve(outputDirectory, `${name}.log`),
			timeoutMs,
		});
		if (result.code !== 0) throw new Error(`${name} exited ${result.code}`);
		return result;
	};
	const control = async (modes, resetCounts = true) => {
		const payload = Buffer.from(
			JSON.stringify({ ...modes, reset_counts: resetCounts }),
		).toString("base64url");
		const script =
			"const body=Buffer.from(process.argv[1],'base64url').toString();fetch('http://127.0.0.1:9080/__control',{method:'POST',headers:{authorization:'Bearer '+process.env.FAULT_PROVIDER_CONTROL_TOKEN,'content-type':'application/json'},body}).then(async r=>{if(!r.ok)throw new Error(await r.text());console.log(await r.text())})";
		await compose(
			"fault-control",
			`mk_compose exec -T fault-provider node -e ${quote(script)} ${quote(payload)}`,
			30_000,
		);
	};
	const state = async () => {
		const script =
			"fetch('http://127.0.0.1:9080/__state',{headers:{authorization:'Bearer '+process.env.FAULT_PROVIDER_CONTROL_TOKEN}}).then(async r=>{if(!r.ok)throw new Error(await r.text());console.log(await r.text())})";
		const result = await compose(
			"fault-state",
			`mk_compose exec -T fault-provider node -e ${quote(script)}`,
			30_000,
		);
		const line = result.stdout.trim().split(/\r?\n/).at(-1);
		return JSON.parse(line || "{}");
	};
	const setModes = (input) =>
		control(
			Object.fromEntries(
				Object.entries(input).map(([key, value]) => [
					key,
					assertMode(String(value)),
				]),
			),
		);
	const session = new ProductSession(baseUrl);
	await session.login(email, password);

	try {
		probe = await stage("seed_probe", () =>
			seedProbe({ baseUrl, email, password }),
		);
		await stage("start_fault_overlay", async () => {
			await compose("fault-overlay-up", "mk_compose up -d fault-provider");
			overlayStarted = true;
			await compose(
				"fault-overlay-recreate",
				"mk_compose up -d --no-deps --force-recreate web dbos-worker",
				600_000,
			);
			await waitForReady(baseUrl, 180_000);
			try {
				await verifyProbe({ baseUrl, email, password, probe });
			} catch (error) {
				const diagnostic = await state().catch(() => ({}));
				throw new Error(
					`pass-through baseline failed: ${error instanceof Error ? error.message : String(error)}; provider_state=${JSON.stringify(diagnostic)}`,
				);
			}
			return "pass-through proxy verified before injection";
		});

		for (const mode of ["401", "429", "503"]) {
			await stage(`llm_${mode}`, async () => {
				await setModes({ llm: mode, embedding: "pass", mineru: "pass" });
				const started = performance.now();
				const response = await session.requestDetailed("/api/rag/v1/ask", {
					method: "POST",
					body: {
						library_id: probe.library_id,
						question: `Repeat the recovery marker ${probe.marker}.`,
					},
					expected: [200, 401, 429, 500, 502, 503, 504],
					timeoutMs: 20_000,
				});
				const elapsed = Math.round(performance.now() - started);
				const unsafeAnswer =
					response.status < 300 &&
					response.body?.refused !== true &&
					String(response.body?.answer || "").trim().length > 0;
				const current = await state();
				if ((current.counts?.llm ?? 0) < 1)
					throw new Error("LLM fault was not exercised");
				if (unsafeAnswer)
					throw new Error("LLM outage returned a non-refused generated answer");
				return `status=${response.status} provider_calls=${current.counts.llm} bounded_ms=${elapsed}`;
			});
		}

		await stage("embedding_timeout", async () => {
			await setModes({ llm: "pass", embedding: "timeout", mineru: "pass" });
			const started = performance.now();
			const response = await session.requestDetailed("/api/rag/v1/retrieve", {
				method: "POST",
				body: { library_id: probe.library_id, query: probe.marker },
				expected: [500, 502, 503, 504],
				timeoutMs: 10_000,
			});
			const elapsed = Math.round(performance.now() - started);
			const current = await state();
			if ((current.counts?.embedding ?? 0) < 1)
				throw new Error("Embedding timeout was not exercised");
			if (elapsed > 8_000)
				throw new Error(
					`Embedding failure exceeded the 8s bound (${elapsed}ms)`,
				);
			return `status=${response.status} provider_calls=${current.counts.embedding} bounded_ms=${elapsed}`;
		});

		await stage("failed_replace_keeps_active", async () => {
			await setModes({ llm: "pass", embedding: "401", mineru: "pass" });
			const before = await session.request(
				`/api/libraries/${probe.library_id}/documents/${probe.document_id}/versions`,
			);
			const form = new FormData();
			form.set(
				"file",
				new Blob(
					[
						`# Failed replacement\n\nReplacement ${randomBytes(8).toString("hex")}\n`,
					],
					{ type: "text/markdown" },
				),
				"failed-replacement.md",
			);
			const replacement = await session.request(
				`/api/libraries/${probe.library_id}/documents/${probe.document_id}/versions`,
				{ method: "POST", body: form, expected: [202] },
			);
			const job = await waitForJob(
				session,
				replacement.job_id,
				Number(args["job-timeout-ms"] || 180_000),
			);
			if (!["failed", "dead"].includes(job.status))
				throw new Error(`faulted replacement ended as ${job.status}`);
			const after = await session.request(
				`/api/libraries/${probe.library_id}/documents/${probe.document_id}/versions`,
			);
			if (
				!before.active_version_id ||
				after.active_version_id !== before.active_version_id
			)
				throw new Error("failed replacement changed the active version");
			return `job=${job.status} active_version_preserved=${after.active_version_id}`;
		});

		if (mineruFixture) {
			await stage("mineru_401", async () => {
				await setModes({ llm: "pass", embedding: "pass", mineru: "401" });
				const library = await session.request("/api/libraries", {
					method: "POST",
					body: {
						name: `MinerU fault ${new Date().toISOString()}`,
						parse_preference: "quality",
						document_profile: "table_heavy",
					},
					expected: [200, 201],
				});
				try {
					const bytes = await readFile(mineruFixture);
					const form = new FormData();
					form.set(
						"file",
						new Blob([bytes], { type: "application/pdf" }),
						basename(mineruFixture),
					);
					const uploaded = await session.request(
						`/api/libraries/${library.id}/documents`,
						{ method: "POST", body: form, expected: [202] },
					);
					const job = await waitForJob(
						session,
						uploaded.job_id,
						Number(args["job-timeout-ms"] || 180_000),
					);
					const current = await state();
					if ((current.counts?.mineru ?? 0) < 1)
						throw new Error("MinerU fault was not exercised");
					if (!["failed", "dead"].includes(job.status))
						throw new Error(`faulted MinerU ingest ended as ${job.status}`);
					return `job=${job.status} provider_calls=${current.counts.mineru}`;
				} finally {
					await deleteLibraryAndWait(
						session,
						library.id,
						Number(args["job-timeout-ms"] || 180_000),
					).catch(() => undefined);
				}
			});
		}

		await stage("provider_recovery", async () => {
			await setModes({ llm: "pass", embedding: "pass", mineru: "pass" });
			await verifyProbe({ baseUrl, email, password, probe });
			return "all Provider paths restored without manual data repair";
		});
		report.result = "PASS";
	} finally {
		if (overlayStarted) {
			await stage("restore_base_runtime", async () => {
				await compose(
					"fault-overlay-stop",
					"mk_compose rm -sf fault-provider",
					120_000,
				);
				const baseResult = await runCommand({
					command: "bash",
					args: [
						"-lc",
						"source scripts/compose-env.sh; mk_compose up -d --no-deps --force-recreate web dbos-worker",
					],
					cwd: composeDirectory,
					logPath: resolve(outputDirectory, "base-runtime-recreate.log"),
					timeoutMs: 600_000,
				});
				if (baseResult.code !== 0)
					throw new Error(`base runtime recreation exited ${baseResult.code}`);
				await waitForReady(baseUrl, 180_000);
				if (probe) await verifyProbe({ baseUrl, email, password, probe });
				return "base Provider configuration restored and verified";
			}).catch(() => {
				report.result = "FAIL";
			});
		}
		if (probe) {
			await cleanupProbe({ baseUrl, email, password, probe }).catch((error) => {
				report.stages.push({
					name: "cleanup_probe",
					status: "FAIL",
					detail: error instanceof Error ? error.message : String(error),
				});
				report.result = "FAIL";
			});
		}
		report.finished_at = new Date().toISOString();
		await writeEvidence({
			jsonPath: resolve(outputDirectory, "provider-faults.json"),
			markdownPath: resolve(outputDirectory, "provider-faults.md"),
			report,
		});
	}
	return report.result === "PASS" ? 0 : 1;
}

if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
	main()
		.then((code) => process.exit(code))
		.catch((error) => {
			console.error(
				`${error?.exitCode === EXIT_BLOCKED ? "BLOCKED" : "FAIL"}: ${error instanceof Error ? error.message : error}`,
			);
			process.exit(error?.exitCode ?? 1);
		});
}
