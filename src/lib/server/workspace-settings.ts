import "server-only";

import { eq } from "drizzle-orm";

import { getDatabase } from "@/db";
import { auditLogs, workspaceSettings, workspaces } from "@/db/schema";

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

export type PatchWorkspaceAskSettingsOptions = {
	expectedPolicyVersion?: number;
};

export async function patchWorkspaceAskSettings(
	workspaceId: string,
	partial: unknown,
	updatedBy?: string | null,
	options?: PatchWorkspaceAskSettingsOptions,
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
	| { ok: false; detail: string; status: number; code?: string }
> {
	const validated = validateAskPatch(partial);
	if (!validated.ok) {
		return { ok: false, detail: validated.detail, status: 400 };
	}
	const expectedVersion = options?.expectedPolicyVersion;
	if (
		expectedVersion !== undefined &&
		(!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
	) {
		return {
			ok: false,
			detail: "policy_version must be a positive integer",
			code: "invalid_version",
			status: 400,
		};
	}

	return getDatabase().transaction(async (tx) => {
		// Serialize partial patches even before the first settings row exists.
		const [workspace] = await tx
			.select({
				id: workspaces.id,
				organizationId: workspaces.organizationId,
				status: workspaces.status,
			})
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.for("update");
		if (workspace?.status !== "active") {
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

		const currentVersion = existing?.policyVersion ?? 1;
		if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
			return {
				ok: false,
				detail: "policy_version conflict: workspace ask settings were updated",
				code: "version_conflict",
				status: 409,
			};
		}

		const current = sanitizeStoredAsk(existing?.ask ?? {});
		const next = mergeAskPatch(current, validated.patch);
		const changed = JSON.stringify(current) !== JSON.stringify(next);
		const now = new Date();
		const version = currentVersion + Number(changed);
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
		if (changed) {
			await tx.insert(auditLogs).values({
				organizationId: workspace.organizationId,
				workspaceId,
				actorId: updatedBy ?? null,
				action: "workspace.ask_settings.updated",
				resourceType: "workspace",
				resourceId: workspaceId,
				details: {
					policy_version: version,
					previous_policy_version: currentVersion,
					changed_keys: Object.keys(validated.patch).sort(),
					ask: next,
				},
				createdAt: now,
			});
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
