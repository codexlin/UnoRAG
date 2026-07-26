import "server-only";

import { eq } from "drizzle-orm";

import { getDatabase } from "@/db";
import { workspaceSettings } from "@/db/schema";

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
	ASK_SETTING_DEFAULTS,
	ASK_SETTING_KEYS,
	mergeAskPatch,
	PUBLIC_ASK_DEFAULTS,
	publicAskDefaults,
	resolveStoredAskOverrides,
	sanitizeStoredAsk,
	validateAskPatch,
} from "./workspace-ask-settings.mjs";

export async function getWorkspaceAskSettings(workspaceId: string) {
	const db = getDatabase();
	const [row] = await db
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

	const db = getDatabase();
	const [existing] = await db
		.select({
			ask: workspaceSettings.ask,
			policyVersion: workspaceSettings.policyVersion,
		})
		.from(workspaceSettings)
		.where(eq(workspaceSettings.workspaceId, workspaceId))
		.limit(1);

	const current = sanitizeStoredAsk(existing?.ask ?? {});
	const next = mergeAskPatch(current, validated.patch);
	const unchanged =
		JSON.stringify(current) === JSON.stringify(next) && Boolean(existing);
	const now = new Date();
	const nextVersion = unchanged
		? (existing?.policyVersion ?? 1)
		: (existing?.policyVersion ?? 0) + 1;

	if (existing) {
		await db
			.update(workspaceSettings)
			.set({
				ask: next,
				...(unchanged
					? {}
					: {
							askPrevious: current,
							policyVersion: nextVersion,
						}),
				updatedAt: now,
				updatedBy: updatedBy ?? null,
			})
			.where(eq(workspaceSettings.workspaceId, workspaceId));
	} else {
		await db.insert(workspaceSettings).values({
			workspaceId,
			ask: next,
			askPrevious: null,
			policyVersion: 1,
			createdAt: now,
			updatedAt: now,
			updatedBy: updatedBy ?? null,
		});
	}

	const [row] = await db
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

	return {
		ok: true,
		ask: sanitizeStoredAsk(row?.ask ?? next),
		defaults: publicAskDefaults(),
		policy_version: row?.policyVersion ?? nextVersion,
		updated_at: (row?.updatedAt ?? now).toISOString(),
		updated_by: row?.updatedBy ?? updatedBy ?? null,
		ask_previous: row?.askPrevious ?? null,
	};
}
