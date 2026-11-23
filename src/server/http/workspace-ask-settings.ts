import { canManageMembers } from "../../lib/server/workspace-permissions.mjs";
import type {
	getWorkspaceAskSettings,
	patchWorkspaceAskSettings,
} from "../../lib/server/workspace-settings";

type Dependencies = {
	resolveIdentity(
		request: Request,
	): Promise<{ workspaceId: string; principalId: string; role: string } | null>;
	read: typeof getWorkspaceAskSettings;
	patch: typeof patchWorkspaceAskSettings;
};

function json(body: unknown, init?: ResponseInit) {
	return Response.json(body, {
		...init,
		headers: { "cache-control": "private, no-store" },
	});
}

export function createWorkspaceAskSettingsHandlers(deps: Dependencies) {
	async function readSettings(request: Request) {
		const identity = await deps.resolveIdentity(request);
		if (!identity) {
			return json({ detail: "authentication required" }, { status: 401 });
		}
		const payload = await deps.read(identity.workspaceId);
		return json({
			ask: payload.ask,
			defaults: payload.defaults,
			policy_version: payload.policy_version,
			updated_at: payload.updated_at,
			updated_by: payload.updated_by,
			can_manage: canManageMembers(identity),
		});
	}

	async function updateSettings(request: Request) {
		const identity = await deps.resolveIdentity(request);
		if (!identity) {
			return json({ detail: "authentication required" }, { status: 401 });
		}
		if (!canManageMembers(identity)) {
			return json({ detail: "forbidden" }, { status: 403 });
		}
		let body: { ask?: unknown };
		try {
			body = (await request.json()) as typeof body;
		} catch {
			return json({ detail: "invalid JSON body" }, { status: 400 });
		}
		const result = await deps.patch(
			identity.workspaceId,
			body?.ask,
			identity.principalId,
		);
		if (!result.ok) {
			return json({ detail: result.detail }, { status: result.status });
		}
		return json({
			ask: result.ask,
			defaults: result.defaults,
			policy_version: result.policy_version,
			updated_at: result.updated_at,
			updated_by: result.updated_by,
			can_manage: true,
		});
	}

	return { GET: readSettings, PATCH: updateSettings };
}
