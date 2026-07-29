/**
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveSessionSecret(env = process.env) {
	const secret =
		env.UNORAG_SESSION_SECRET?.trim() ||
		env.MERIKNOW_SESSION_SECRET?.trim() ||
		"";
	if (secret.length < 32) {
		throw new Error(
			"UNORAG_SESSION_SECRET (or legacy MERIKNOW_SESSION_SECRET) must contain at least 32 characters",
		);
	}
	const internalSecret =
		env.UNORAG_INTERNAL_SECRET?.trim() || env.MERIKNOW_INTERNAL_SECRET?.trim();
	if (internalSecret && secret === internalSecret) {
		throw new Error("session secret must differ from internal signing secret");
	}
	return secret;
}

/**
 * Resolve the product-prefixed secret while keeping one rolling-upgrade window
 * for deployments that used the former MERIKNOW_* variable.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveInternalSecret(env = process.env) {
	const secret =
		env.UNORAG_INTERNAL_SECRET?.trim() ||
		env.MERIKNOW_INTERNAL_SECRET?.trim() ||
		"";
	if (secret.length < 32) {
		throw new Error(
			"UNORAG_INTERNAL_SECRET (or legacy MERIKNOW_INTERNAL_SECRET) must contain at least 32 characters",
		);
	}
	return secret;
}

/**
 * The legacy family is an explicit rollback bridge, never an automatic guess.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveInternalHeaderFamily(env = process.env) {
	const family =
		env.UNORAG_INTERNAL_AUTH_HEADER_FAMILY?.trim().toLowerCase() || "unorag";
	if (family !== "unorag" && family !== "meriknow") {
		throw new Error(
			"UNORAG_INTERNAL_AUTH_HEADER_FAMILY must be unorag or meriknow",
		);
	}
	return family;
}
