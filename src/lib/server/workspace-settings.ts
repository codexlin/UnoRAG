import "server-only";

import { eq } from "drizzle-orm";

import { getDatabase } from "@/db";
import { workspaceSettings, workspaces } from "@/db/schema";

import {
	mergeAskPatch,
	type PUBLIC_ASK_DEFAULTS,
	publicAskDefaults,
	sanitizeStoredAsk,
	validateAskPatch,
} from "./workspace-ask-settings.mjs";

export {
	ASK_INTERNAL_DEFAULTS,
	ASK_PUBLIC_KEYS,
	mergeAskPatch,
	PUBLIC_ASK_DEFAULTS,
	publicAskDefaults,
	resolveStoredAskOverrides,
	sanitizeStoredAsk,
	validateAskPatch,
} from "./workspace-ask-settings.mjs";

export async function getWorkspaceAskSettings(workspaceId: string) {
	const db = getDatabase();
	const rows = await db
		.select({
			ask: workspaceSettings.ask,
			askPrevious: workspaceSettings.askPrevious,
			policyVersion: workspaceSettings.policyVersion,
			updatedAt: workspaceSettings.updatedAt,
			updatedBy: workspaceSettings.updatedBy,
		})
		.from(workspaceSettings)
		.where(eq(workspaceSettings.workspaceId, workspaceId))
		.limit(1);

	const row = rows.at(0);
	const ask = sanitizeStoredAsk(row?.ask ?? {});
	return {
		ask,
		defaults: publicAskDefaults(),
		policy_version: row?.policyVersion ?? 1,
		updated_at: row?.updatedAt?.toISOString() ?? null,
		updated_by: row?.updatedBy ?? null,
		ask_previous: row?.askPrevious ?? null,
	};
}

export async function patchWorkspaceAskSettings(
	workspaceId: string,
	partial: unknown,
	updatedBy?: string | null,
): Promise<
	| {
			ok: true;
			ask: Record<string, unknown>;
			defaults: typeof PUBLIC_ASK_DEFAULTS;
			policy_version: number;
			updated_at: string;
			updated_by: string | null;
			ask_previous: Record<string, unknown> | null;
	  }
	| { ok: false; detail: string; status: number }
> {
	const validated = validateAskPatch(partial);
	if (!validated.ok) {
		return { ok: false, detail: validated.detail, status: 400 };
	}

	return getDatabase().transaction(async (tx) => {
		// Serialize partial patches even before the first settings row exists.
		const [workspace] = await tx
			.select({ id: workspaces.id })
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.for("update");
		if (!workspace) {
			return { ok: false, detail: "workspace not found", status: 404 };
		}
		const [existing] = await tx
			.select({
				ask: workspaceSettings.ask,
				askPrevious: workspaceSettings.askPrevious,
				policyVersion: workspaceSettings.policyVersion,
			})
			.from(workspaceSettings)
			.where(eq(workspaceSettings.workspaceId, workspaceId))
			.limit(1);

		const current = sanitizeStoredAsk(existing?.ask ?? {});
		const next = mergeAskPatch(current, validated.patch);
		const changed = JSON.stringify(current) !== JSON.stringify(next);
		const now = new Date();
		const version = existing ? existing.policyVersion + Number(changed) : 1;
		const previous = existing
			? changed
				? current
				: existing.askPrevious
			: null;
		const values = {
			ask: next,
			askPrevious: previous,
			policyVersion: version,
			updatedAt: now,
			updatedBy: updatedBy ?? null,
		};

		if (existing) {
			await tx
				.update(workspaceSettings)
				.set(values)
				.where(eq(workspaceSettings.workspaceId, workspaceId));
		} else {
			await tx
				.insert(workspaceSettings)
				.values({ ...values, workspaceId, createdAt: now });
		}
		return {
			ok: true,
			ask: next,
			defaults: publicAskDefaults(),
			policy_version: version,
			updated_at: now.toISOString(),
			updated_by: values.updatedBy,
			ask_previous: previous,
		};
	});
}
