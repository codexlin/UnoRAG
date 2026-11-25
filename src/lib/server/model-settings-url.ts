import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_HOSTNAMES = new Set([
	"0.0.0.0",
	"::",
	"[::]",
	"169.254.169.254",
	"100.100.100.200",
	"metadata.google.internal",
	"metadata.goog",
	"metadata",
	"instance-data",
	"metadata.tencentyun.com",
]);

function parseIpv4Octets(
	address: string,
): [number, number, number, number] | null {
	const parts = address.split(".");
	if (parts.length !== 4) return null;
	const octets: number[] = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const n = Number(part);
		if (n < 0 || n > 255) return null;
		octets.push(n);
	}
	return [octets[0], octets[1], octets[2], octets[3]];
}

function isBlockedIpv4Octets(
	octets: [number, number, number, number],
): boolean {
	const [a, b, c, d] = octets;
	// 0.0.0.0/8 ("this host" / unspecified bind range)
	if (a === 0) return true;
	// 169.254.0.0/16 (AWS/GCP/Azure/OpenStack link-local & cloud IMDS)
	if (a === 169 && b === 254) return true;
	// 100.100.100.200/32 (Alibaba Cloud ECS metadata)
	if (a === 100 && b === 100 && c === 100 && d === 200) return true;
	return false;
}

function parseIpv6Bytes(raw: string): Uint8Array | null {
	const stripped = raw.split("%")[0].toLowerCase();
	if (!stripped || stripped.includes(":::")) return null;

	// Handle dotted-quad tail like ::ffff:169.254.169.254
	let working = stripped;
	const lastColon = working.lastIndexOf(":");
	if (lastColon !== -1 && working.slice(lastColon + 1).includes(".")) {
		const ipv4 = parseIpv4Octets(working.slice(lastColon + 1));
		if (!ipv4) return null;
		const hi = ((ipv4[0] << 8) | ipv4[1]).toString(16);
		const lo = ((ipv4[2] << 8) | ipv4[3]).toString(16);
		working = `${working.slice(0, lastColon + 1)}${hi}:${lo}`;
	}

	const halves = working.split("::");
	if (halves.length > 2) return null;

	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - (left.length + right.length);
	if (halves.length === 1 && missing !== 0) return null;
	if (halves.length === 2 && missing < 0) return null;

	const groups = [
		...left,
		...Array<string>(Math.max(0, missing)).fill("0"),
		...right,
	];
	if (groups.length !== 8) return null;

	const bytes = new Uint8Array(16);
	for (let i = 0; i < 8; i += 1) {
		if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
		const val = Number.parseInt(groups[i], 16);
		bytes[i * 2] = (val >> 8) & 0xff;
		bytes[i * 2 + 1] = val & 0xff;
	}
	return bytes;
}

function isBlockedIpv6Bytes(bytes: Uint8Array): boolean {
	// ::/128 (unspecified)
	if (bytes.every((b) => b === 0)) return true;

	// fe80::/10 (IPv6 link-local: fe80:: through febf::)
	if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;

	// fd00:ec2::254/128 (AWS IMDSv2 IPv6 endpoint)
	if (
		bytes[0] === 0xfd &&
		bytes[1] === 0x00 &&
		bytes[2] === 0x0e &&
		bytes[3] === 0xc2 &&
		bytes.slice(4, 14).every((b) => b === 0) &&
		bytes[14] === 0x02 &&
		bytes[15] === 0x54
	) {
		return true;
	}

	// ::ffff:0:0/96 (IPv4-mapped IPv6 — WHATWG URL canonicalizes to pure hex!)
	const isIpv4Mapped =
		bytes.slice(0, 10).every((b) => b === 0) &&
		bytes[10] === 0xff &&
		bytes[11] === 0xff;
	if (isIpv4Mapped) {
		return isBlockedIpv4Octets([bytes[12], bytes[13], bytes[14], bytes[15]]);
	}

	// ::/96 (deprecated IPv4-compatible IPv6, excluding ::1 loopback)
	const isIpv4Compatible =
		bytes.slice(0, 12).every((b) => b === 0) &&
		!(bytes[12] === 0 && bytes[13] === 0 && bytes[14] === 0 && bytes[15] === 1);
	if (isIpv4Compatible) {
		return isBlockedIpv4Octets([bytes[12], bytes[13], bytes[14], bytes[15]]);
	}

	// 64:ff9b::/96 (RFC 6052 well-known NAT64 prefix)
	const isNat64 =
		bytes[0] === 0x00 &&
		bytes[1] === 0x64 &&
		bytes[2] === 0xff &&
		bytes[3] === 0x9b &&
		bytes.slice(4, 12).every((b) => b === 0);
	if (isNat64) {
		return isBlockedIpv4Octets([bytes[12], bytes[13], bytes[14], bytes[15]]);
	}

	return false;
}

export function isBlockedIpAddress(address: string): boolean {
	const cleaned = address
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "");
	if (!cleaned) return true;
	const ipv4 = parseIpv4Octets(cleaned);
	if (ipv4) return isBlockedIpv4Octets(ipv4);
	const ipv6 = parseIpv6Bytes(cleaned);
	if (ipv6) return isBlockedIpv6Bytes(ipv6);
	return false;
}

export function isBlockedModelHost(hostname: string): boolean {
	const lower = hostname.trim().toLowerCase().replace(/\.+$/, "");
	if (!lower) return true;
	if (BLOCKED_HOSTNAMES.has(lower)) return true;
	const unbracketed =
		lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
	if (BLOCKED_HOSTNAMES.has(unbracketed)) return true;
	return isBlockedIpAddress(unbracketed);
}

export class UnsafeModelEndpointError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsafeModelEndpointError";
	}
}

/**
 * Validates model provider base URLs entered by organization owners.
 * Allows HTTPS, private-GPU LAN hosts, localhost, and host.docker.internal,
 * while blocking non-HTTP(S) schemes, query/fragment injection, embedded URL
 * credentials, and cloud metadata / unspecified bind addresses (including
 * IPv4-mapped/NAT64/link-local IPv6).
 */
export function assertSafeModelEndpointUrl(
	rawUrl: string,
	fieldName = "base_url",
): string {
	const trimmed = rawUrl.trim();
	if (!trimmed) {
		throw new UnsafeModelEndpointError(`${fieldName} is required`);
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new UnsafeModelEndpointError(`${fieldName} must be a valid URL`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new UnsafeModelEndpointError(`${fieldName} must use http or https`);
	}
	if (parsed.username || parsed.password) {
		throw new UnsafeModelEndpointError(
			`${fieldName} must not embed credentials in the URL`,
		);
	}
	if (
		parsed.search ||
		parsed.hash ||
		trimmed.includes("?") ||
		trimmed.includes("#")
	) {
		throw new UnsafeModelEndpointError(
			`${fieldName} must not contain query parameters or fragments`,
		);
	}
	if (isBlockedModelHost(parsed.hostname)) {
		throw new UnsafeModelEndpointError(
			`${fieldName} targets a blocked metadata or unspecified host`,
		);
	}
	return parsed.href.replace(/\/+$/, "");
}

export type HostLookupFn = (
	hostname: string,
) => Promise<Array<{ address: string }>>;

const defaultHostLookup: HostLookupFn = async (hostname) =>
	dnsLookup(hostname, { all: true });

/**
 * Resolves a model endpoint hostname via DNS and verifies none of its returned
 * IP addresses fall into blocked cloud metadata or unspecified bind ranges.
 */
export async function assertResolvedModelEndpointSafe(
	rawUrl: string,
	lookup: HostLookupFn = defaultHostLookup,
): Promise<void> {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new UnsafeModelEndpointError("endpoint must be a valid URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new UnsafeModelEndpointError("endpoint must use http or https");
	}
	if (parsed.username || parsed.password) {
		throw new UnsafeModelEndpointError(
			"endpoint must not embed credentials in the URL",
		);
	}
	const unbracketed = parsed.hostname
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.+$/, "");
	if (isBlockedModelHost(unbracketed)) {
		throw new UnsafeModelEndpointError(
			"endpoint targets a blocked metadata or unspecified host",
		);
	}
	if (isIP(unbracketed) !== 0) {
		return;
	}
	let records: Array<{ address: string }>;
	try {
		records = await lookup(unbracketed);
	} catch {
		// Let the subsequent fetch surface standard network/DNS resolution failure.
		return;
	}
	for (const record of records) {
		if (isBlockedIpAddress(record.address)) {
			throw new UnsafeModelEndpointError(
				"endpoint resolved to a blocked metadata or unspecified address",
			);
		}
	}
}

const NATIVE_FETCH = globalThis.fetch;

/**
 * Outbound fetch wrapper for model/rerank providers. Always enforces
 * `redirect: "error"` and host/IP checks, and performs DNS resolution checks
 * whenever invoking real network I/O (skipping live DNS only when tests mock
 * `globalThis.fetch`).
 */
export function createSafeModelFetch(options?: {
	fetch?: typeof globalThis.fetch;
	lookup?: HostLookupFn;
}): typeof globalThis.fetch {
	return async (input, init) => {
		const targetUrl =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		const activeFetch = options?.fetch ?? globalThis.fetch;
		const shouldResolveDns =
			Boolean(options?.lookup) || activeFetch === NATIVE_FETCH;

		if (shouldResolveDns) {
			await assertResolvedModelEndpointSafe(targetUrl, options?.lookup);
		} else {
			let parsed: URL;
			try {
				parsed = new URL(targetUrl);
			} catch {
				throw new UnsafeModelEndpointError("endpoint must be a valid URL");
			}
			if (
				(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
				parsed.username ||
				parsed.password ||
				isBlockedModelHost(parsed.hostname)
			) {
				throw new UnsafeModelEndpointError(
					"endpoint targets a blocked metadata or unspecified host",
				);
			}
		}

		return activeFetch(input, {
			...init,
			redirect: "error",
		});
	};
}
