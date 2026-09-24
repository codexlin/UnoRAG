import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	EXIT_BLOCKED,
	parseArguments,
	readReleaseManifest,
	requireEnvironment,
	runCommand,
	waitForReady,
	writeEvidence,
} from "./lib/runtime.mjs";
import { cleanupProbe, seedProbe, verifyProbe } from "./recovery-probe.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const upgradeScript = resolve(root, "deploy/compose/scripts/upgrade.sh");
const composeDirectory = resolve(root, "deploy/compose");

function releaseIdentity(manifest) {
	return {
		version: manifest.values.UNORAG_VERSION,
		revision: manifest.values.UNORAG_REVISION,
		dbos_application_version: manifest.values.UNORAG_DBOS_APPLICATION_VERSION,
		web_image: manifest.values.UNORAG_WEB_IMAGE,
	};
}

function assertHealthIdentity(health, manifest, label) {
	const release = health.release ?? {};
	if (release.version !== manifest.values.UNORAG_VERSION) {
		throw new Error(
			`${label} version mismatch: ${release.version ?? "missing"}`,
		);
	}
	if (release.revision !== manifest.values.UNORAG_REVISION) {
		throw new Error(
			`${label} revision mismatch: ${release.revision ?? "missing"}`,
		);
	}
}

async function main() {
	const args = parseArguments(process.argv.slice(2));
	if (!args["previous-manifest"] || !args["candidate-manifest"]) {
		throw new Error(
			"--previous-manifest and --candidate-manifest are required",
		);
	}
	const allowLocalImages = args["allow-local-images"] === true;
	if (allowLocalImages && args.plan !== true) {
		const error = new Error(
			"--allow-local-images is only valid with --plan; executable rollback requires immutable image digests",
		);
		error.exitCode = EXIT_BLOCKED;
		throw error;
	}
	const previous = await readReleaseManifest(
		String(args["previous-manifest"]),
		{ allowLocalImages },
	);
	const candidate = await readReleaseManifest(
		String(args["candidate-manifest"]),
		{ allowLocalImages },
	);
	if (previous.values.UNORAG_REVISION === candidate.values.UNORAG_REVISION) {
		throw new Error(
			"previous and candidate manifests must identify different revisions",
		);
	}
	const baseUrl = String(
		args["base-url"] || process.env.UNORAG_BASE_URL || "http://localhost:3000",
	).replace(/\/$/, "");
	const email = String(
		args.email || process.env.UNORAG_ADMIN_EMAIL || "admin@unorag.local",
	);
	const passwordEnv = String(args["password-env"] || "UNORAG_ADMIN_PASSWORD");
	const password = process.env[passwordEnv];
	const leave = String(args.leave || "candidate");
	if (!["candidate", "previous"].includes(leave))
		throw new Error("--leave must be candidate or previous");
	const allowPlatformEmulation = args["allow-platform-emulation"] === true;
	const outputDirectory = resolve(
		String(args["output-dir"] || "scripts/acceptance/.upgrade-rollback-work"),
	);
	const reportPath = resolve(outputDirectory, "upgrade-rollback.json");
	const markdownPath = resolve(outputDirectory, "upgrade-rollback.md");
	const plan = {
		previous: releaseIdentity(previous),
		candidate: releaseIdentity(candidate),
		leave,
		allow_platform_emulation: allowPlatformEmulation,
		base_url: baseUrl,
		steps: [
			"verify_previous",
			"seed_probe",
			"upgrade_candidate",
			"rollback_previous",
			...(leave === "candidate" ? ["upgrade_candidate_final"] : []),
			"verify_probe",
			"lifecycle_gate",
		],
	};
	if (args.plan === true) {
		console.log(JSON.stringify(plan, null, 2));
		return 0;
	}
	requireEnvironment("UNORAG_ACCEPT_UPGRADE_ROLLBACK", "YES");
	if (!password) {
		const error = new Error(`${passwordEnv} is required`);
		error.exitCode = EXIT_BLOCKED;
		throw error;
	}
	await mkdir(outputDirectory, { recursive: true });
	const report = {
		schema_version: 1,
		name: "UnoRAG digest upgrade and application rollback",
		started_at: new Date().toISOString(),
		git_revision: process.env.GITHUB_SHA || "local",
		plan,
		stages: [],
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
	const runUpgrade = async (manifest, name) => {
		const upgradeArgs = [
			upgradeScript,
			"--manifest",
			manifest.path,
			"--skip-smoke",
		];
		if (allowPlatformEmulation)
			upgradeArgs.push("--allow-platform-emulation");
		const result = await runCommand({
			command: "bash",
			args: upgradeArgs,
			cwd: composeDirectory,
			logPath: resolve(outputDirectory, `${name}.log`),
			timeoutMs: Number(args["upgrade-timeout-ms"] || 3_600_000),
		});
		if (result.code !== 0) throw new Error(`${name} exited ${result.code}`);
		const health = await waitForReady(baseUrl);
		assertHealthIdentity(health, manifest, name);
		await verifyProbe({ baseUrl, email, password, probe });
		return `release=${manifest.values.UNORAG_VERSION} revision=${manifest.values.UNORAG_REVISION.slice(0, 12)}`;
	};

	try {
		await stage("verify_previous", async () => {
			assertHealthIdentity(
				await waitForReady(baseUrl),
				previous,
				"current deployment",
			);
			return "running release matches previous manifest";
		});
		probe = await stage("seed_probe", () =>
			seedProbe({ baseUrl, email, password }),
		);
		await stage("upgrade_candidate", () =>
			runUpgrade(candidate, "upgrade-candidate"),
		);
		await stage("rollback_previous", () =>
			runUpgrade(previous, "rollback-previous"),
		);
		if (leave === "candidate")
			await stage("upgrade_candidate_final", () =>
				runUpgrade(candidate, "upgrade-candidate-final"),
			);
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
		report.result = "PASS";
	} finally {
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
