import { createServer } from "node:http";

const port = Number.parseInt(process.env.FAULT_PROVIDER_PORT || "9080", 10);
const controlToken = process.env.FAULT_PROVIDER_CONTROL_TOKEN || "";
const llmUpstream = (process.env.FAULT_LLM_UPSTREAM_BASE_URL || "").replace(
	/\/$/,
	"",
);
const mineruUpstream = (
	process.env.FAULT_MINERU_UPSTREAM_BASE_URL || ""
).replace(/\/$/, "");
const defaultDelayMs = Number.parseInt(
	process.env.FAULT_PROVIDER_DELAY_MS || "30000",
	10,
);
const modes = { llm: "pass", embedding: "pass", mineru: "pass" };
const counts = { llm: 0, embedding: 0, mineru: 0, unsupported: 0 };
const last = { kind: null, path: null, upstream_status: null, error: null };

function category(pathname) {
	if (pathname.endsWith("/embeddings")) return "embedding";
	if (pathname.includes("/chat/completions")) return "llm";
	if (pathname.includes("file_parse") || pathname.includes("/tasks"))
		return "mineru";
	return null;
}

async function readBody(request) {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	return Buffer.concat(chunks);
}

function json(response, status, body, headers = {}) {
	response.writeHead(status, {
		"content-type": "application/json",
		...headers,
	});
	response.end(JSON.stringify(body));
}

async function proxy(request, response, kind, body) {
	const upstream = kind === "mineru" ? mineruUpstream : llmUpstream;
	if (!upstream) {
		json(response, 503, {
			error: {
				code: "fault_upstream_missing",
				message: "acceptance upstream is not configured",
			},
		});
		return;
	}
	const incoming = new URL(request.url, "http://fault-provider");
	const base = new URL(upstream.endsWith("/") ? upstream : `${upstream}/`);
	const relative =
		kind === "mineru"
			? incoming.pathname.replace(/^\//, "")
			: incoming.pathname.replace(/^\/v1\/?/, "");
	const target = new URL(relative, base);
	target.search = incoming.search;
	const headers = new Headers();
	const hopByHopHeaders = new Set([
		"connection",
		"content-length",
		"host",
		"keep-alive",
		"proxy-authenticate",
		"proxy-authorization",
		"te",
		"trailer",
		"transfer-encoding",
		"upgrade",
	]);
	for (const [name, value] of Object.entries(request.headers)) {
		if (value && !hopByHopHeaders.has(name))
			headers.set(name, Array.isArray(value) ? value.join(",") : value);
	}
	const upstreamResponse = await fetch(target, {
		method: request.method,
		headers,
		body:
			request.method === "GET" || request.method === "HEAD" ? undefined : body,
	});
	last.kind = kind;
	last.path = incoming.pathname;
	last.upstream_status = upstreamResponse.status;
	last.error = null;
	const responseHeaders = Object.fromEntries(
		[...upstreamResponse.headers.entries()].filter(
			([name]) =>
				!["content-encoding", "content-length", "transfer-encoding"].includes(
					name,
				),
		),
	);
	response.writeHead(upstreamResponse.status, responseHeaders);
	response.end(Buffer.from(await upstreamResponse.arrayBuffer()));
}

async function handleFault(request, response, kind, mode, body) {
	counts[kind] += 1;
	if (mode === "pass") return proxy(request, response, kind, body);
	if (mode === "timeout") {
		await new Promise((resolveWait) => setTimeout(resolveWait, defaultDelayMs));
		json(response, 504, {
			error: { code: "fault_timeout", message: "injected timeout" },
		});
		return;
	}
	if (mode === "malformed") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end("{not-json");
		return;
	}
	const status = Number.parseInt(mode, 10);
	if ([401, 429, 503].includes(status)) {
		json(
			response,
			status,
			{
				error: { code: `fault_${status}`, message: `injected HTTP ${status}` },
			},
			status === 429 || status === 503 ? { "retry-after": "1" } : {},
		);
		return;
	}
	json(response, 500, {
		error: {
			code: "fault_mode_invalid",
			message: "invalid acceptance fault mode",
		},
	});
}

const server = createServer(async (request, response) => {
	try {
		const url = new URL(request.url, "http://fault-provider");
		if (url.pathname === "/healthz")
			return json(response, 200, { status: "ok" });
		if (url.pathname === "/__state") {
			if (
				!controlToken ||
				request.headers.authorization !== `Bearer ${controlToken}`
			)
				return json(response, 403, { error: "forbidden" });
			return json(response, 200, { modes, counts, last });
		}
		if (url.pathname === "/__control" && request.method === "POST") {
			if (
				!controlToken ||
				request.headers.authorization !== `Bearer ${controlToken}`
			)
				return json(response, 403, { error: "forbidden" });
			const body = JSON.parse(
				(await readBody(request)).toString("utf8") || "{}",
			);
			for (const key of Object.keys(modes)) {
				if (body[key] !== undefined) modes[key] = String(body[key]);
			}
			if (body.reset_counts === true)
				for (const key of Object.keys(counts)) counts[key] = 0;
			return json(response, 200, { modes, counts, last });
		}
		const kind = category(url.pathname);
		if (!kind) {
			counts.unsupported += 1;
			last.kind = "unsupported";
			last.path = url.pathname;
			last.upstream_status = null;
			last.error = "unsupported_path";
			return json(response, 404, {
				error: "unsupported acceptance provider path",
			});
		}
		await handleFault(
			request,
			response,
			kind,
			modes[kind],
			await readBody(request),
		);
	} catch (error) {
		last.error = error instanceof Error ? error.name : "Error";
		json(response, 502, {
			error: {
				code: "fault_proxy_failed",
				message: error instanceof Error ? error.name : "Error",
			},
		});
	}
});

server.listen(port, "0.0.0.0", () => {
	process.stdout.write(`fault provider ready on ${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => server.close(() => process.exit(0)));
}
