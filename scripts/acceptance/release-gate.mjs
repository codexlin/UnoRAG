import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	EXIT_BLOCKED,
	parseArguments,
	runCommand,
	writeEvidence,
} from "./lib/runtime.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const acceptanceDirectory = resolve(root, "scripts/acceptance");

function requiredString(value, name) {
	if (typeof value !== "string" || !value.trim())
		throw new Error(`${name} is required`);
	return value.trim();
}

function validateProfile(input) {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new Error("release gate profile must be an object");
	if (input.schema_version !== 1)
		throw new Error("release gate profile schema_version must be 1");
	const allowed = new Set([
		"schema_version",
		"release_id",
		"expected_git_revision",
		"base_url",
		"admin_email",
		"password_env",
		"previous_manifest",
		"candidate_manifest",
		"mineru_fixture",
		"output_directory",
		"require_clean_worktree",
		"gates",
	]);
	for (const key of Object.keys(input))
		if (!allowed.has(key))
			throw new Error(`unknown release gate profile field: ${key}`);
	const gates = input.gates;
	if (!gates || typeof gates !== "object" || Array.isArray(gates))
		throw new Error("gates is required");
	const gateNames = new Set([
		"code",
		"browser",
		"runtime",
		"upgrade_rollback",
		"provider_faults",
		"restore",
	]);
	for (const key of Object.keys(gates))
		if (!gateNames.has(key)) throw new Error(`unknown gate: ${key}`);
	for (const key of gateNames)
		if (typeof gates[key] !== "boolean")
			throw new Error(`gates.${key} must be boolean`);
	if (gates.upgrade_rollback) {
		requiredString(input.previous_manifest, "previous_manifest");
		requiredString(input.candidate_manifest, "candidate_manifest");
	}
	const expectedRevision = requiredString(
		input.expected_git_revision,
		"expected_git_revision",
	);
	if (!/^[a-f0-9]{40}$/.test(expectedRevision)) {
		throw new Error("expected_git_revision must be a full lowercase Git SHA");
	}
	return {
		...input,
		release_id: requiredString(input.release_id, "release_id"),
		expected_git_revision: expectedRevision,
		base_url: requiredString(input.base_url, "base_url").replace(/\/$/, ""),
		admin_email: requiredString(input.admin_email, "admin_email"),
		password_env: requiredString(input.password_env, "password_env"),
		output_directory: String(
			input.output_directory || "scripts/acceptance/.release-gate-work",
		),
		require_clean_worktree: input.require_clean_worktree !== false,
	};
}

async function main() {
	const args = parseArguments(process.argv.slice(2));
	const profilePath = resolve(
		String(args.profile || "scripts/acceptance/release-gate.example.json"),
	);
	const profile = validateProfile(
		JSON.parse(await readFile(profilePath, "utf8")),
	);
	const outputDirectory = resolve(root, profile.output_directory);
	const commonEnvironment = {
		UNORAG_BASE_URL: profile.base_url,
		UNORAG_ADMIN_EMAIL: profile.admin_email,
	};
	const plan = {
		release_id: profile.release_id,
		expected_git_revision: profile.expected_git_revision,
		base_url: profile.base_url,
		gates: profile.gates,
		output_directory: outputDirectory,
	};
	if (args.plan === true) {
		console.log(JSON.stringify(plan, null, 2));
		return 0;
	}
	if (!process.env[profile.password_env]) {
		const error = new Error(`${profile.password_env} is required`);
		error.exitCode = EXIT_BLOCKED;
		throw error;
	}

	const report = {
		schema_version: 1,
		name: `UnoRAG Release Gate ${profile.release_id}`,
		started_at: new Date().toISOString(),
		git_revision: profile.expected_git_revision,
		profile: plan,
		stages: [],
		result: "FAIL",
	};
	const stage = async (name, command, commandArgs, options = {}) => {
		const result = await runCommand({
			command,
			args: commandArgs,
			cwd: options.cwd || root,
			env: { ...commonEnvironment, ...(options.env || {}) },
			logPath: resolve(outputDirectory, `${name}.log`),
			timeoutMs: options.timeoutMs || 3_600_000,
		});
		const status =
			result.code === 0
				? "PASS"
				: result.code === EXIT_BLOCKED
					? "BLOCKED"
					: "FAIL";
		report.stages.push({
			name,
			status,
			duration_ms: result.duration_ms,
			detail: result.code === 0 ? "completed" : `exit=${result.code}`,
		});
		if (result.code !== 0) {
			const error = new Error(
				`${name} ${status.toLowerCase()} with exit ${result.code}`,
			);
			error.exitCode = result.code;
			throw error;
		}
	};
	const nodeAcceptance = (name, script, scriptArgs, env = {}) =>
		stage(
			name,
			process.execPath,
			[resolve(acceptanceDirectory, script), ...scriptArgs],
			{ env, timeoutMs: 7_200_000 },
		);

	try {
		await stage("git_revision", "git", ["rev-parse", "HEAD"], {
			timeoutMs: 30_000,
		});
		const actualRevision = (
			await runCommand({
				command: "git",
				args: ["rev-parse", "HEAD"],
				cwd: root,
				stream: false,
			})
		).stdout.trim();
		if (actualRevision !== profile.expected_git_revision)
			throw new Error(
				`HEAD ${actualRevision} does not match expected revision`,
			);
		if (profile.require_clean_worktree) {
			const worktree = await runCommand({
				command: "git",
				args: ["status", "--porcelain"],
				cwd: root,
				stream: false,
			});
			if (worktree.stdout.trim())
				throw new Error("release gate requires a clean worktree");
			report.stages.push({
				name: "clean_worktree",
				status: "PASS",
				duration_ms: worktree.duration_ms,
				detail: "clean",
			});
		}

		if (profile.gates.code) {
			for (const [name, commandArgs] of [
				[
					"node_runtime",
					[
						"exec",
						"node",
						"-e",
						"if (Number(process.versions.node.split('.')[0]) !== 22) { console.error('Node 22 required, received ' + process.version); process.exit(1); }",
					],
				],
				["verify", ["verify"]],
				["test_fast", ["test:fast"]],
				["test_contract", ["test:contract"]],
				["test_integration", ["test:integration"]],
				["audit_prod", ["audit:prod"]],
				["db_check", ["db:check"]],
				["build", ["build"]],
			])
				await stage(name, "pnpm", commandArgs);
		}
		if (profile.gates.upgrade_rollback) {
			await nodeAcceptance(
				"upgrade_rollback",
				"upgrade-rollback.mjs",
				[
					"--previous-manifest",
					resolve(root, profile.previous_manifest),
					"--candidate-manifest",
					resolve(root, profile.candidate_manifest),
					"--base-url",
					profile.base_url,
					"--email",
					profile.admin_email,
					"--password-env",
					profile.password_env,
					"--output-dir",
					resolve(outputDirectory, "upgrade-rollback"),
				],
				{
					UNORAG_ACCEPT_UPGRADE_ROLLBACK:
						process.env.UNORAG_ACCEPT_UPGRADE_ROLLBACK || "",
				},
			);
		}
		if (profile.gates.runtime) {
			await stage("pilot_preflight", "bash", [
				resolve(root, "deploy/compose/scripts/pilot-preflight.sh"),
			]);
			await stage(
				"pilot_smoke",
				"bash",
				[resolve(root, "deploy/compose/scripts/pilot-smoke.sh")],
				{ cwd: resolve(root, "deploy/compose") },
			);
			await stage("isolation", "bash", [
				resolve(acceptanceDirectory, "s1_s2_isolation.sh"),
			]);
			await stage("evaluation_stability", "pnpm", ["eval:stability"], {
				timeoutMs: 7_200_000,
			});
		}
		if (profile.gates.provider_faults) {
			const providerArgs = [
				"--base-url",
				profile.base_url,
				"--email",
				profile.admin_email,
				"--password-env",
				profile.password_env,
				"--output-dir",
				resolve(outputDirectory, "provider-faults"),
			];
			if (profile.mineru_fixture)
				providerArgs.push(
					"--mineru-fixture",
					resolve(root, profile.mineru_fixture),
				);
			await nodeAcceptance(
				"provider_faults",
				"provider-faults.mjs",
				providerArgs,
				{
					UNORAG_ACCEPT_PROVIDER_FAULTS:
						process.env.UNORAG_ACCEPT_PROVIDER_FAULTS || "",
				},
			);
		}
		if (profile.gates.restore) {
			await nodeAcceptance(
				"restore",
				"restore-drill.mjs",
				[
					"--base-url",
					profile.base_url,
					"--email",
					profile.admin_email,
					"--password-env",
					profile.password_env,
					"--output-dir",
					resolve(outputDirectory, "restore"),
				],
				{
					UNORAG_ACCEPT_DESTRUCTIVE_RESTORE:
						process.env.UNORAG_ACCEPT_DESTRUCTIVE_RESTORE || "",
				},
			);
		}
		if (profile.gates.browser) {
			await stage("browser_e2e", "pnpm", ["test:e2e"], {
				env: {
					UNORAG_E2E_BASE_URL: profile.base_url,
					UNORAG_E2E_ADMIN_EMAIL: profile.admin_email,
					UNORAG_E2E_ADMIN_PASSWORD: process.env[profile.password_env],
				},
				timeoutMs: 3_600_000,
			});
		}
		report.result = "PASS";
	} finally {
		report.finished_at = new Date().toISOString();
		await writeEvidence({
			jsonPath: resolve(outputDirectory, "release-gate.json"),
			markdownPath: resolve(outputDirectory, "release-gate.md"),
			report,
		});
	}
	return 0;
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

export { validateProfile };
