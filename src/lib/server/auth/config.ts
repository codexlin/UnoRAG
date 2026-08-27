const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function enabled(value: string | undefined, fallback = false): boolean {
	if (value == null || value.trim() === "") return fallback;
	return TRUE_VALUES.has(value.trim().toLowerCase());
}

function required(name: string, env: NodeJS.ProcessEnv): string {
	const value = env[name]?.trim();
	if (!value) throw new Error(`${name} is required when OIDC_ENABLED=true`);
	return value;
}

export type OidcSettings = Readonly<{
	issuerUrl: string;
	clientId: string;
	clientSecret: string;
	clientAuthMethod: "client_secret_post" | "client_secret_basic";
	scopes: string;
	organizationId: string;
	buttonLabel: string;
	trustEmailClaim: boolean;
}>;

export function isLocalLoginEnabled(env = process.env): boolean {
	return enabled(env.LOCAL_AUTH_ENABLED, true);
}

export function isOidcEnabled(env = process.env): boolean {
	return enabled(env.OIDC_ENABLED);
}

export function readOidcSettings(env = process.env): OidcSettings {
	const issuerUrl = required("OIDC_ISSUER_URL", env);
	const clientId = required("OIDC_CLIENT_ID", env);
	const clientSecret = required("OIDC_CLIENT_SECRET", env);
	const organizationId =
		env.OIDC_ORGANIZATION_ID?.trim() || required("UNORAG_ORGANIZATION_ID", env);
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			organizationId,
		)
	) {
		throw new Error("OIDC_ORGANIZATION_ID must be a canonical UUID");
	}
	const configuredScopes = env.OIDC_SCOPES?.trim() || "openid profile email";
	const scopes = Array.from(
		new Set(["openid", ...configuredScopes.split(/\s+/).filter(Boolean)]),
	).join(" ");
	const method = env.OIDC_CLIENT_AUTH_METHOD?.trim() || "client_secret_post";
	if (method !== "client_secret_post" && method !== "client_secret_basic") {
		throw new Error(
			"OIDC_CLIENT_AUTH_METHOD must be client_secret_post or client_secret_basic",
		);
	}
	const issuer = new URL(issuerUrl);
	if (env.NODE_ENV === "production" && issuer.protocol !== "https:") {
		throw new Error("OIDC_ISSUER_URL must use HTTPS in production");
	}
	return {
		issuerUrl,
		clientId,
		clientSecret,
		clientAuthMethod: method,
		scopes,
		organizationId,
		buttonLabel: env.OIDC_BUTTON_LABEL?.trim() || "使用企业账号登录",
		trustEmailClaim: enabled(env.OIDC_TRUST_EMAIL_CLAIM),
	};
}

export function publicAuthCapabilities(env = process.env) {
	return {
		local: isLocalLoginEnabled(env),
		oidc: isOidcEnabled(env),
		oidcLabel: env.OIDC_BUTTON_LABEL?.trim() || "使用企业账号登录",
	};
}

export function resolveApplicationOrigin(
	requestUrl: string,
	env = process.env,
): string {
	const configured = env.APP_BASE_URL?.trim();
	if (isOidcEnabled(env) && env.NODE_ENV === "production" && !configured) {
		throw new Error("APP_BASE_URL is required for production OIDC");
	}
	const url = new URL(configured || requestUrl);
	if (url.username || url.password) {
		throw new Error("APP_BASE_URL must not contain credentials");
	}
	if (env.NODE_ENV === "production" && url.protocol !== "https:") {
		throw new Error("APP_BASE_URL must use HTTPS in production");
	}
	return url.origin;
}
