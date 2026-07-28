/**
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveSessionSecret(env = process.env) {
	const secret = env.UNORAG_SESSION_SECRET?.trim() ?? "";
	if (secret.length < 32) {
		throw new Error(
			"UNORAG_SESSION_SECRET must contain at least 32 characters",
		);
	}
	const internalSecret = env.UNORAG_INTERNAL_SECRET?.trim();
	if (internalSecret && secret === internalSecret) {
		throw new Error(
			"UNORAG_SESSION_SECRET must differ from UNORAG_INTERNAL_SECRET",
		);
	}
	return secret;
}
