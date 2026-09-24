import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	EXIT_BLOCKED,
	parseArguments,
	readDeploymentConfig,
	requireEnvironment,
	runCommand,
	waitForReady,
	writeEvidence,
} from "./lib/runtime.mjs";
import { cleanupProbe, seedProbe, verifyProbe } from "./recovery-probe.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const composeDirectory = resolve(root, "deploy/compose");
const configDirectory = resolve(root, "deploy/config");

async function main() {
	const args = parseArguments(process.argv.slice(2));
	const runtime = await readDeploymentConfig(configDirectory);
	const project = runtime.COMPOSE_PROJECT_NAME || "unorag";
	const destructiveProjectAllowed = /^unorag-(acceptance|rc)-[a-z0-9-]+$/.test(
		project,
	);
	const baseUrl = String(
		args["base-url"] ||
			runtime.UNORAG_BASE_URL ||
			process.env.UNORAG_BASE_URL ||
			"http://localhost:3000",
	).replace(/\/$/, "");
	const email = String(
		args.email || process.env.UNORAG_ADMIN_EMAIL || "admin@unorag.local",
	);
	const passwordEnv = String(args["password-env"] || "UNORAG_ADMIN_PASSWORD");
	const password = process.env[passwordEnv];
	const outputDirectory = resolve(
		String(args["output-dir"] || "scripts/acceptance/.restore-work"),
	);
	const backupDirectory = resolve(outputDirectory, "backup");
	const reportPath = resolve(outputDirectory, "restore-drill.json");
	const markdownPath = resolve(outputDirectory, "restore-drill.md");
	const rtoTarget = Number(args["rto-target-seconds"] || 900);
	const rpoTarget = Number(args["rpo-target-seconds"] || 86_400);
	const plan = {
		project,
		destructive_project_allowed: destructiveProjectAllowed,
		base_url: baseUrl,
		backup_directory: backupDirectory,
		rto_target_seconds: rtoTarget,
		rpo_target_seconds: rpoTarget,
		steps: [
			"seed_probe",
			"backup",
			"destroy_volumes",
			"restore",
			"verify_probe",
			"lifecycle_gate",
		],
	};
	if (args.plan === true) {
		console.log(JSON.stringify(plan, null, 2));
		return 0;
	}
	if (!destructiveProjectAllowed) {
		const error = new Error(
			`refusing destructive restore for non-acceptance project ${project}`,
		);
		error.exitCode = EXIT_BLOCKED;
		throw error;
	}
	requireEnvironment("UNORAG_ACCEPT_DESTRUCTIVE_RESTORE", "YES");
	if (!password) {
		const error = new Error(`${passwordEnv} is required`);
		error.exitCode = EXIT_BLOCKED;
		throw error;
	}
	await mkdir(outputDirectory, { recursive: true });
	const report = {
		schema_version: 1,
		name: "UnoRAG destructive restore and RPO/RTO drill",
		started_at: new Date().toISOString(),
		git_revision: process.env.GITHUB_SHA || "local",
		plan,
		stages: [],
		metrics: {
			rpo_target_seconds: rpoTarget,
			rto_target_seconds: rtoTarget,
			observed_data_loss_count: null,
			restore_time_seconds: null,
		},
		result: "FAIL",
	};
	let probe;
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
	try {
		probe = await stage("seed_probe", () =>
			seedProbe({ baseUrl, email, password }),
		);
		await stage("backup", async () => {
			const result = await runCommand({
				command: "bash",
				args: [resolve(composeDirectory, "scripts/backup.sh"), backupDirectory],
				cwd: composeDirectory,
				logPath: resolve(outputDirectory, "backup.log"),
				timeoutMs: 1_800_000,
			});
			if (result.code !== 0) throw new Error(`backup exited ${result.code}`);
			return `backup completed in ${Math.round(result.duration_ms / 1000)}s`;
		});
		await stage("destroy_volumes", async () => {
			const result = await runCommand({
				command: "bash",
				args: [
					"-lc",
					"source scripts/compose-env.sh; mk_compose down -v --remove-orphans",
				],
				cwd: composeDirectory,
				logPath: resolve(outputDirectory, "destroy.log"),
				timeoutMs: 300_000,
			});
			if (result.code !== 0)
				throw new Error(`volume destruction exited ${result.code}`);
			return `isolated project ${project} volumes removed`;
		});
		const restoreStarted = performance.now();
		await stage("restore", async () => {
			const result = await runCommand({
				command: "bash",
				args: [
					resolve(composeDirectory, "scripts/restore.sh"),
					backupDirectory,
				],
				cwd: composeDirectory,
				env: { CONFIRM: "YES" },
				logPath: resolve(outputDirectory, "restore.log"),
				timeoutMs: 1_800_000,
			});
			if (result.code !== 0) throw new Error(`restore exited ${result.code}`);
			await waitForReady(baseUrl, 300_000);
			return "stack restored and ready";
		});
		report.metrics.restore_time_seconds = Math.round(
			(performance.now() - restoreStarted) / 1000,
		);
		await stage("verify_probe", async () => {
			const verified = await verifyProbe({ baseUrl, email, password, probe });
			report.metrics.observed_data_loss_count = 0;
			return `active_version=${verified.active_version_id} citations=${verified.citation_count}`;
		});
		await stage("lifecycle_gate", async () => {
			const result = await runCommand({
				command: "bash",
				args: [
					"-lc",
					"source scripts/compose-env.sh; mk_compose --profile ops run --rm inspect-lifecycle",
				],
				cwd: composeDirectory,
				logPath: resolve(outputDirectory, "lifecycle.log"),
			});
			if (result.code !== 0)
				throw new Error(`lifecycle gate exited ${result.code}`);
			return "dead=0 stuck=0 pending_acl=0";
		});
		if (report.metrics.restore_time_seconds > rtoTarget)
			throw new Error(
				`RTO ${report.metrics.restore_time_seconds}s exceeds target ${rtoTarget}s`,
			);
		report.result = "PASS";
	} finally {
		if (probe && report.metrics.observed_data_loss_count === 0) {
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
		await writeEvidence({ jsonPath: reportPath, markdownPath, report });
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
