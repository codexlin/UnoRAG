import "server-only";

import type { AuthIdentity } from "@/lib/server/auth/provider";
import { resolveRequestSession } from "@/lib/server/auth/session";
import { findAuthorizedLibrary } from "@/lib/server/library-access";
import { sourceReferences } from "./authorized-history";
import {
	DrizzleHistoricalCitationAuthorizer,
	type HistoricalCitationAuthorizer,
} from "./conversation-handler";

export class AskAccessRevokedError extends Error {
	readonly code = "ask_access_changed";

	constructor() {
		super("Ask access changed; start a new request");
		this.name = "AskAccessRevokedError";
	}
}

export type AskAuthorizationDependencies = {
	refreshIdentity: () => Promise<AuthIdentity | null>;
	resolveLibrary: typeof findAuthorizedLibrary;
	citationAuthorizer: HistoricalCitationAuthorizer;
};

function identityScope(identity: AuthIdentity): string {
	return JSON.stringify([
		identity.tenantId,
		identity.workspaceId,
		identity.principalId,
		identity.role,
		identity.organizationRole,
		[...new Set(identity.groupIds)].sort(),
		identity.mustChangePassword,
	]);
}

/** Checkpoints bound revocation exposure; they cannot recall already sent data. */
export class AskAuthorizationCheckpoint {
	private checkedAt = Number.NEGATIVE_INFINITY;
	private checkedEvidence = "";
	private readonly admittedEvidence = new Set<string>();
	private readonly initialScope: string;

	constructor(
		identity: AuthIdentity,
		private readonly libraryId: string,
		private readonly dependencies: AskAuthorizationDependencies,
		private readonly clock = () => performance.now(),
	) {
		this.initialScope = identityScope(identity);
	}

	async check(
		citations: Record<string, unknown>[],
		options: { force?: boolean } = {},
	): Promise<void> {
		// Active evidence may exceed the smaller reusable-memory dependency budget.
		const references = sourceReferences(citations, 1_024);
		if (references === null) throw new AskAccessRevokedError();
		const evidence = JSON.stringify(references);
		if (
			!options.force &&
			evidence === this.checkedEvidence &&
			this.clock() - this.checkedAt < 1_000
		) {
			return;
		}
		const current = await this.dependencies.refreshIdentity();
		if (
			!current ||
			current.mustChangePassword ||
			identityScope(current) !== this.initialScope ||
			!(await this.dependencies.resolveLibrary(current, this.libraryId))
		) {
			throw new AskAccessRevokedError();
		}
		if (references.length > 0) {
			const fresh = references.filter(
				(reference) => !this.admittedEvidence.has(JSON.stringify(reference)),
			);
			const retained = references.filter((reference) =>
				this.admittedEvidence.has(JSON.stringify(reference)),
			);
			for (const [citations, versionPolicy] of [
				[fresh, "active"],
				[retained, "retained"],
			] as const) {
				if (!citations.length) continue;
				const allowed =
					await this.dependencies.citationAuthorizer.filterAuthorized({
						identity: current,
						libraryId: this.libraryId,
						citations,
						versionPolicy,
					});
				const allowedKeys = new Set(
					allowed.map((reference) => JSON.stringify(reference)),
				);
				if (
					citations.some(
						(reference) => !allowedKeys.has(JSON.stringify(reference)),
					)
				)
					throw new AskAccessRevokedError();
			}
			for (const reference of fresh)
				this.admittedEvidence.add(JSON.stringify(reference));
		}
		this.checkedEvidence = evidence;
		this.checkedAt = this.clock();
	}
}

export function createAskAuthorizationDependencies(input: {
	request: Request;
	refreshIdentity?: AskAuthorizationDependencies["refreshIdentity"];
}): AskAuthorizationDependencies {
	return {
		refreshIdentity:
			input.refreshIdentity ?? (() => resolveRequestSession(input.request)),
		resolveLibrary: findAuthorizedLibrary,
		citationAuthorizer: new DrizzleHistoricalCitationAuthorizer(),
	};
}
