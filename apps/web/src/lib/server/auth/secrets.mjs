/**
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveSessionSecret(env = process.env) {
	const secret = env.MERIKNOW_SESSION_SECRET?.trim() ?? "";
	if (secret.length < 32) {
		throw new Error(
			"MERIKNOW_SESSION_SECRET must contain at least 32 characters",
		);
	}
	const internalSecret = env.MERIKNOW_INTERNAL_SECRET?.trim();
	if (internalSecret && secret === internalSecret) {
		throw new Error(
			"MERIKNOW_SESSION_SECRET must differ from MERIKNOW_INTERNAL_SECRET",
		);
	}
	return secret;
}
