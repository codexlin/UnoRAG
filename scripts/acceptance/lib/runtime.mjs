import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const EXIT_PASS = 0;
export const EXIT_FAIL = 1;
export const EXIT_BLOCKED = 2;

const SECRET_PATTERNS = [
	[/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>"],
	[/\bmk_svc_[A-Za-z0-9_-]+/g, "mk_svc_<redacted>"],
	[
		/(password|secret|token|api[_-]?key)(\s*[=:]\s*)[^\s,}"']+/gi,
		"$1$2<redacted>",
	],
];

export function redactText(value, secretValues = []) {
	let result = String(value ?? "");
	for (const secret of [...secretValues].sort(
		(left, right) => right.length - left.length,
	)) {
		if (secret.length >= 6) result = result.split(secret).join("<redacted>");
	}
	for (const [pattern, replacement] of SECRET_PATTERNS) {
		result = result.replace(pattern, replacement);
	}
	return result;
}

function environmentSecretValues(environment) {
	return new Set(
		Object.entries(environment)
			.filter(
				([key, value]) =>
					/(^|_)(password|secret|token|api_?key|authorization)$/i.test(key) &&
					typeof value === "string",
			)
			.map(([, value]) => value)
			.filter((value) => value.length >= 6),
	);
}

export function redactValue(value) {
	if (Array.isArray(value)) return value.map(redactValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				/(^|_)(password|secret|token|api_?key|authorization)$/i.test(key)
					? "<redacted>"
					: redactValue(item),
			]),
		);
	}
	return typeof value === "string" ? redactText(value) : value;
}

export function parseKeyValue(contents) {
	const result = {};
	for (const rawLine of contents.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		if (separator < 1) continue;
		result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
	}
	return result;
}

export async function readReleaseManifest(
	path,
	{ allowLocalImages = false } = {},
) {
	const absolutePath = resolve(path);
	const values = parseKeyValue(await readFile(absolutePath, "utf8"));
	const imageKeys = [
		"UNORAG_WEB_IMAGE",
		"UNORAG_WEB_MIGRATOR_IMAGE",
		"UNORAG_WEB_OPS_IMAGE",
		"UNORAG_DBOS_WORKER_IMAGE",
	];
	for (const key of imageKeys) {
		if (!values[key]) throw new Error(`${key} is missing from ${absolutePath}`);
		if (!allowLocalImages && !/@sha256:[a-f0-9]{64}$/.test(values[key])) {
			throw new Error(`${key} must use an immutable sha256 digest`);
		}
	}
	for (const key of [
		"UNORAG_DBOS_APPLICATION_VERSION",
		"UNORAG_VERSION",
		"UNORAG_REVISION",
	]) {
		if (!values[key]) throw new Error(`${key} is missing from ${absolutePath}`);
	}
	return { path: absolutePath, values };
}

export function parseArguments(argv) {
	const values = {};
	for (let index = 0; index < argv.length; index += 1) {
		const item = argv[index];
		if (!item.startsWith("--")) throw new Error(`unexpected argument: ${item}`);
		const name = item.slice(2);
		const next = argv[index + 1];
		if (!next || next.startsWith("--")) {
			values[name] = true;
			continue;
		}
		values[name] = next;
		index += 1;
	}
	return values;
}

export async function runCommand({
	command,
	args = [],
	cwd,
	env = {},
	logPath,
	timeoutMs = 0,
	stream = true,
}) {
	if (logPath) await mkdir(dirname(logPath), { recursive: true });
	const startedAt = new Date();
	const started = performance.now();
	const childEnvironment = { ...process.env, ...env };
	const secretValues = environmentSecretValues(childEnvironment);
	const child = spawn(command, args, {
		cwd,
		env: childEnvironment,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		const text = chunk.toString();
		stdout += text;
		if (stream) process.stdout.write(redactText(text, secretValues));
	});
	child.stderr.on("data", (chunk) => {
		const text = chunk.toString();
		stderr += text;
		if (stream) process.stderr.write(redactText(text, secretValues));
	});
	let timeout;
	let forceKillTimeout;
	let timedOut = false;
	if (timeoutMs > 0) {
		timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			forceKillTimeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
		}, timeoutMs);
	}
	const result = await new Promise((resolveResult, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) =>
			resolveResult({ code: code ?? 1, signal: signal ?? null }),
		);
	});
	if (timeout) clearTimeout(timeout);
	if (forceKillTimeout) clearTimeout(forceKillTimeout);
	const combined = redactText(
		`${stdout}${stderr ? `\n${stderr}` : ""}`,
		secretValues,
	);
	if (logPath) {
		await writeFile(logPath, combined, { mode: 0o600 });
		await chmod(logPath, 0o600).catch(() => undefined);
	}
	return {
		...result,
		timed_out: timedOut,
		started_at: startedAt.toISOString(),
		finished_at: new Date().toISOString(),
		duration_ms: Math.round(performance.now() - started),
		stdout: redactText(stdout, secretValues),
		stderr: redactText(stderr, secretValues),
	};
}

export async function writeEvidence({ jsonPath, markdownPath, report }) {
	const safeReport = redactValue(report);
	const json = `${JSON.stringify(safeReport, null, 2)}\n`;
	await mkdir(dirname(jsonPath), { recursive: true });
	await writeFile(jsonPath, json, { mode: 0o600 });
	await chmod(jsonPath, 0o600).catch(() => undefined);
	const digest = createHash("sha256").update(json).digest("hex");
	await writeFile(
		`${jsonPath}.sha256`,
		`${digest}  ${jsonPath.split("/").at(-1)}\n`,
		{
			mode: 0o600,
		},
	);
	if (markdownPath) {
		const markdownCell = (value) => {
			const rendered =
				value && typeof value === "object"
					? JSON.stringify(value)
					: String(value ?? "");
			const compact = rendered.replaceAll(/\s+/g, " ").replaceAll("|", "\\|");
			return compact.length > 500 ? `${compact.slice(0, 497)}...` : compact;
		};
		const rows = (safeReport.stages ?? [])
			.map(
				(stage) =>
					`| ${markdownCell(stage.name)} | ${markdownCell(stage.status)} | ${stage.duration_ms ?? "-"} | ${markdownCell(stage.detail)} |`,
			)
			.join("\n");
		const markdown = `# ${safeReport.name}\n\n- Result: **${safeReport.result}**\n- Commit: \`${safeReport.git_revision ?? "unknown"}\`\n- Started: ${safeReport.started_at}\n- Finished: ${safeReport.finished_at}\n- Evidence SHA256: \`${digest}\`\n\n| Stage | Status | Duration ms | Detail |\n|---|---:|---:|---|\n${rows || "| none | BLOCKED | - | no stages ran |"}\n`;
		await writeFile(markdownPath, markdown, { mode: 0o600 });
		await chmod(markdownPath, 0o600).catch(() => undefined);
	}
	return digest;
}

export async function fetchJson(
	url,
	options = {},
	expected = [200],
	timeoutMs = 30_000,
) {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const signal = options.signal
		? AbortSignal.any([options.signal, timeoutSignal])
		: timeoutSignal;
	const response = await fetch(url, { ...options, signal });
	const raw = await response.text();
	let body = null;
	if (raw) {
		try {
			body = JSON.parse(raw);
		} catch {
			body = { raw: raw.slice(0, 500) };
		}
	}
	if (!expected.includes(response.status)) {
		throw new Error(
			`HTTP ${response.status} from ${new URL(url).pathname}: ${redactText(raw).slice(0, 300)}`,
		);
	}
	return { response, body };
}

export async function readDeploymentConfig(configDirectory) {
	const values = {};
	for (const name of ["runtime.advanced.env", "runtime.env"]) {
		try {
			Object.assign(
				values,
				parseKeyValue(await readFile(resolve(configDirectory, name), "utf8")),
			);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
	}
	return values;
}

export async function waitForReady(baseUrl, timeoutMs = 180_000) {
	const deadline = Date.now() + timeoutMs;
	let last = "not attempted";
	do {
		try {
			const response = await fetch(
				`${baseUrl.replace(/\/$/, "")}/api/rag/health/ready`,
			);
			last = `HTTP ${response.status}`;
			if (response.ok) return await response.json();
		} catch (error) {
			last = error instanceof Error ? error.message : String(error);
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
	} while (Date.now() < deadline);
	throw new Error(`readiness timed out: ${last}`);
}

export function requireEnvironment(name, expected) {
	if (process.env[name] !== expected) {
		const error = new Error(`${name}=${expected} is required`);
		error.exitCode = EXIT_BLOCKED;
		throw error;
	}
}
