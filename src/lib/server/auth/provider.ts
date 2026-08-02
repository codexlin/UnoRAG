import "server-only";

export type AuthIdentity = {
	tenantId: string;
	workspaceId: string;
	workspaceName: string;
	principalId: string;
	groupIds: string[];
	organizationRole: string;
	role: string;
	email: string | null;
	displayName: string;
	provider: "local" | "oidc";
};

export type LocalCredentialsInput = {
	email: string;
	password: string;
	workspaceId?: string;
};

export type OidcCallbackInput = {
	code: string;
	state: string;
	redirectUri: string;
};

export interface IdentityProvider<TInput> {
	readonly id: "local" | "oidc";
	authenticate(input: TInput): Promise<AuthIdentity | null>;
}

export interface OidcIdentityProvider
	extends IdentityProvider<OidcCallbackInput> {
	authorizationUrl(input: {
		state: string;
		nonce: string;
		redirectUri: string;
	}): Promise<string>;
}
