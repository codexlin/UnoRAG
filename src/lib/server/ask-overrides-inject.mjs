/**
 * Server-authoritative ask_overrides injection (fail-closed).
 * Clients must never supply ask_overrides that ride trusted HMAC.
 */

import { resolveStoredAskOverrides } from "./workspace-ask-settings.mjs";

/**
 * @typedef {{ ok: true, body: Uint8Array } | { ok: false, status: 400 | 503, detail: string }} AskOverrideInjectResult
 */

/**
 * Strip client ask_overrides, resolve workspace policy, inject server overrides.
 *
 * @param {Uint8Array} body
 * @param {string} workspaceId
 * @param {(workspaceId: string) => Promise<{ ask: Record<string, unknown>, policy_version?: number }>} loadSettings
 * @param {{ questionKeys?: string[] }} [options]
 * @returns {Promise<AskOverrideInjectResult>}
 */
export async function injectAskOverrides(
	body,
	workspaceId,
	loadSettings,
	options = {},
) {
	const questionKeys = options.questionKeys ?? ["question"];
	let payload;
	try {
		payload = JSON.parse(new TextDecoder().decode(body));
	} catch {
		return { ok: false, status: 400, detail: "invalid JSON body" };
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return { ok: false, status: 400, detail: "JSON body must be an object" };
	}

	// Always ignore client-supplied overrides (even if settings load fails).
	delete payload.ask_overrides;

	let settings;
	try {
		settings = await loadSettings(workspaceId);
	} catch {
		return {
			ok: false,
			status: 503,
			detail: "workspace policy unavailable",
		};
	}
	if (!settings || typeof settings !== "object") {
		return {
			ok: false,
			status: 503,
			detail: "workspace policy unavailable",
		};
	}

	let question = null;
	for (const key of questionKeys) {
		const value = payload[key];
		if (typeof value === "string") {
			question = value;
			break;
		}
	}

	try {
		const { overrides, snapshot } = resolveStoredAskOverrides(settings.ask, {
			question,
			policyVersion: settings.policy_version,
		});
		payload.ask_overrides = {
			...overrides,
			_ask_policy: snapshot,
		};
		return {
			ok: true,
			body: new TextEncoder().encode(JSON.stringify(payload)),
		};
	} catch {
		return {
			ok: false,
			status: 503,
			detail: "workspace policy unavailable",
		};
	}
}
