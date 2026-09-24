import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT_BLOCKED, fetchJson, parseArguments } from "./lib/runtime.mjs";

export class ProductSession {
	constructor(baseUrl) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.cookie = "";
	}

	async request(path, { method = "GET", body, expected = [200] } = {}) {
		return (await this.requestDetailed(path, { method, body, expected })).body;
	}

	async requestDetailed(
		path,
		{ method = "GET", body, expected = [200], timeoutMs = 30_000 } = {},
	) {
		const headers = {};
		if (this.cookie) headers.cookie = this.cookie;
		if (body !== undefined && !(body instanceof FormData))
			headers["content-type"] = "application/json";
		const { response, body: responseBody } = await fetchJson(
			`${this.baseUrl}${path}`,
			{
				method,
				headers,
				body:
					body instanceof FormData
						? body
						: body === undefined
							? undefined
							: JSON.stringify(body),
			},
			expected,
			timeoutMs,
		);
		const setCookie = response.headers.get("set-cookie");
		if (setCookie) this.cookie = setCookie.split(";", 1)[0];
		return {
			status: response.status,
			headers: response.headers,
			body: responseBody,
		};
	}

	async login(email, password) {
		return this.request("/api/auth/session", {
			method: "POST",
			body: { email, password },
		});
	}
}

export async function waitForJob(session, jobId, timeoutMs = 300_000) {
	const deadline = Date.now() + timeoutMs;
	do {
		const job = await session.request(`/api/jobs/${jobId}`);
		if (["completed", "failed", "dead", "cancelled"].includes(job.status))
			return job;
		await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
	} while (Date.now() < deadline);
	throw new Error(`job ${jobId} timed out`);
}

export async function seedProbe({
	baseUrl,
	email,
	password,
	timeoutMs = 300_000,
}) {
	const session = new ProductSession(baseUrl);
	const login = await session.login(email, password);
	if (login?.mustChangePassword)
		throw new Error(
			"administrator must replace the bootstrap password before recovery acceptance",
		);
	const marker = `RECOVERY_PROOF_${randomUUID().replaceAll("-", "").toUpperCase()}`;
	const library = await session.request("/api/libraries", {
		method: "POST",
		body: { name: `Recovery acceptance ${new Date().toISOString()}` },
		expected: [200, 201],
	});
	try {
		const form = new FormData();
		form.set(
			"file",
			new Blob([`# Recovery acceptance\n\nUnique marker: \`${marker}\`.\n`], {
				type: "text/markdown",
			}),
			"recovery-acceptance.md",
		);
		form.set("display_name", "Recovery acceptance document");
		const uploaded = await session.request(
			`/api/libraries/${library.id}/documents`,
			{ method: "POST", body: form, expected: [202] },
		);
		const job = await waitForJob(session, uploaded.job_id, timeoutMs);
		if (job.status !== "completed")
			throw new Error(`recovery probe ingest ended as ${job.status}`);
		const versions = await session.request(
			`/api/libraries/${library.id}/documents/${uploaded.document_id}/versions`,
		);
		const ask = await session.request("/api/rag/v1/ask", {
			method: "POST",
			body: {
				library_id: library.id,
				question: `What is the unique marker ${marker}?`,
			},
		});
		if (!JSON.stringify(ask).includes(marker) || ask.refused === true)
			throw new Error("recovery probe Ask did not return the marker");
		return {
			schema_version: 1,
			created_at: new Date().toISOString(),
			library_id: library.id,
			document_id: uploaded.document_id,
			marker,
			active_version_id: versions.active_version_id ?? null,
		};
	} catch (error) {
		await deleteLibraryAndWait(session, library.id, timeoutMs).catch(
			() => undefined,
		);
		throw error;
	}
}

export async function verifyProbe({ baseUrl, email, password, probe }) {
	const session = new ProductSession(baseUrl);
	await session.login(email, password);
	const versions = await session.request(
		`/api/libraries/${probe.library_id}/documents/${probe.document_id}/versions`,
	);
	if (
		probe.active_version_id &&
		versions.active_version_id !== probe.active_version_id
	)
		throw new Error("active version changed across recovery boundary");
	const ask = await session.request("/api/rag/v1/ask", {
		method: "POST",
		body: {
			library_id: probe.library_id,
			question: `What is the unique marker ${probe.marker}?`,
		},
	});
	if (!JSON.stringify(ask).includes(probe.marker) || ask.refused === true)
		throw new Error("restored Ask did not return the recovery marker");
	return {
		active_version_id: versions.active_version_id ?? null,
		citation_count: Array.isArray(ask.citations) ? ask.citations.length : 0,
	};
}

export async function cleanupProbe({
	baseUrl,
	email,
	password,
	probe,
	timeoutMs = 300_000,
}) {
	const session = new ProductSession(baseUrl);
	await session.login(email, password);
	await deleteLibraryAndWait(session, probe.library_id, timeoutMs);
}

export async function deleteLibraryAndWait(session, libraryId, timeoutMs) {
	await session.request(`/api/libraries/${libraryId}`, {
		method: "DELETE",
		expected: [200, 202, 204, 404],
	});
	const deadline = Date.now() + timeoutMs;
	do {
		const libraries = await session.request("/api/libraries");
		if (
			!Array.isArray(libraries) ||
			!libraries.some(
				(library) => library.id === libraryId && library.status !== "deleted",
			)
		) {
			return;
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
	} while (Date.now() < deadline);
	throw new Error(`library ${libraryId} cleanup timed out`);
}

async function main() {
	const args = parseArguments(process.argv.slice(2));
	const command = String(args.command || "");
	const baseUrl = String(
		args["base-url"] || process.env.UNORAG_BASE_URL || "http://localhost:3000",
	);
	const email = String(
		args.email || process.env.UNORAG_ADMIN_EMAIL || "admin@unorag.local",
	);
	const passwordEnv = String(args["password-env"] || "UNORAG_ADMIN_PASSWORD");
	const password = process.env[passwordEnv];
	if (!password) {
		console.error(`BLOCKED: ${passwordEnv} is required`);
		return EXIT_BLOCKED;
	}
	if (command === "seed") {
		const output = resolve(
			String(args.output || "scripts/acceptance/.recovery-probe.json"),
		);
		const probe = await seedProbe({ baseUrl, email, password });
		await writeFile(output, `${JSON.stringify(probe, null, 2)}\n`, {
			mode: 0o600,
		});
		console.log(`PASS: recovery probe written to ${basename(output)}`);
		return 0;
	}
	const input = resolve(
		String(args.input || "scripts/acceptance/.recovery-probe.json"),
	);
	const probe = JSON.parse(await readFile(input, "utf8"));
	if (command === "verify") {
		console.log(
			JSON.stringify(await verifyProbe({ baseUrl, email, password, probe })),
		);
		return 0;
	}
	if (command === "cleanup") {
		await cleanupProbe({ baseUrl, email, password, probe });
		console.log("PASS: recovery probe cleaned up");
		return 0;
	}
	throw new Error("--command must be seed, verify, or cleanup");
}

if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
	main()
		.then((code) => process.exit(code))
		.catch((error) => {
			console.error(`FAIL: ${error instanceof Error ? error.message : error}`);
			process.exit(error?.exitCode ?? 1);
		});
}
