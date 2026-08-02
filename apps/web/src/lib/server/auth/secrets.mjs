/**
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveSessionSecret(env = process.env) {
	const secret = env.UNORAG_SESSION_SECRET?.trim() || "";
	if (secret.length < 32) {
		throw new Error(
			"UNORAG_SESSION_SECRET must contain at least 32 characters",
		);
	}
	return secret;
}
