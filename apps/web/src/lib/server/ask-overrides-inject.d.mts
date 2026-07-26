export function injectAskOverrides(
	body: Uint8Array,
	workspaceId: string,
	loadSettings: (workspaceId: string) => Promise<{
		ask: Record<string, unknown>;
		policy_version?: number;
	}>,
	options?: { questionKeys?: string[] },
): Promise<
	| { ok: true; body: Uint8Array }
	| { ok: false; status: 400 | 503; detail: string }
>;
