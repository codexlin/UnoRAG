import "server-only";

import { eq } from "drizzle-orm";

import { getDatabase } from "@/db";
import { workspaceSettings } from "@/db/schema";

import {
	ASK_SETTING_DEFAULTS,
	mergeAskPatch,
	sanitizeStoredAsk,
	validateAskPatch,
} from "./workspace-ask-settings.mjs";

export {
	ASK_SETTING_DEFAULTS,
	ASK_SETTING_KEYS,
	mergeAskPatch,
	sanitizeStoredAsk,
	validateAskPatch,
} from "./workspace-ask-settings.mjs";

export async function getWorkspaceAskSettings(workspaceId: string) {
	const db = getDatabase();
	const [row] = await db
		.select({ ask: workspaceSettings.ask })
		.from(workspaceSettings)
		.where(eq(workspaceSettings.workspaceId, workspaceId))
		.limit(1);
	const ask = sanitizeStoredAsk(row?.ask ?? {});
	return {
		ask,
		defaults: { ...ASK_SETTING_DEFAULTS },
	};
}

export async function patchWorkspaceAskSettings(
	workspaceId: string,
	partial: unknown,
): Promise<
	| { ok: true; ask: Record<string, unknown>; defaults: typeof ASK_SETTING_DEFAULTS }
	| { ok: false; detail: string; status: number }
> {
	const validated = validateAskPatch(partial);
	if (!validated.ok) {
		return { ok: false, detail: validated.detail, status: 400 };
	}

	const db = getDatabase();
	const [existing] = await db
		.select({ ask: workspaceSettings.ask })
		.from(workspaceSettings)
		.where(eq(workspaceSettings.workspaceId, workspaceId))
		.limit(1);

	const current = sanitizeStoredAsk(existing?.ask ?? {});
	const next = mergeAskPatch(current, validated.patch);
	const now = new Date();

	if (existing) {
		await db
			.update(workspaceSettings)
			.set({ ask: next, updatedAt: now })
			.where(eq(workspaceSettings.workspaceId, workspaceId));
	} else {
		await db.insert(workspaceSettings).values({
			workspaceId,
			ask: next,
			createdAt: now,
			updatedAt: now,
		});
	}

	return {
		ok: true,
		ask: next,
		defaults: { ...ASK_SETTING_DEFAULTS },
	};
}
