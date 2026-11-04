import "server-only";

import type { AuthIdentity } from "@/lib/server/auth/provider";
import {
	MAX_MEMORY_SOURCE_REFERENCES,
	type MemoryProvenance,
	MemoryProvenanceSchema,
	MemorySourceReferenceSchema,
} from "@/server/conversations/memory-provenance";
import type { SessionMemoryMessage } from "@/server/conversations/session-memory";
import type { HistoricalCitationAuthorizer } from "./conversation-handler";

export {
	MAX_MEMORY_SOURCE_REFERENCES,
	type MemoryProvenance,
	MemoryProvenanceSchema,
} from "@/server/conversations/memory-provenance";

export type AuthorizedHistory = {
	messages: { role: "user" | "assistant"; content: string }[];
	sourceReferences: Record<string, unknown>[];
};

type AuthorizationInput = {
	identity: AuthIdentity;
	libraryId: string;
	citationAuthorizer: HistoricalCitationAuthorizer;
};

type HistoryCandidate = {
	role: string;
	content: string;
	complete: boolean;
	provenance?: unknown;
};

type Exchange = {
	messages: AuthorizedHistory["messages"];
	sourceReferences: Record<string, unknown>[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function referenceKey(reference: Record<string, unknown>): string {
	return JSON.stringify([
		reference.doc_id,
		reference.document_version_id,
		reference.generation_id,
		reference.library_id ?? null,
		reference.tenant_id ?? null,
		reference.workspace_id ?? null,
	]);
}

/** Null is invalid lineage, not an empty dependency set. Never drop bad entries. */
export function sourceReferences(
	citations: readonly Record<string, unknown>[],
	maxReferences = MAX_MEMORY_SOURCE_REFERENCES,
): Record<string, unknown>[] | null {
	const limit = Number.isNaN(maxReferences)
		? MAX_MEMORY_SOURCE_REFERENCES
		: Math.max(1, Math.min(1_024, Math.floor(maxReferences)));
	const references = new Map<string, Record<string, unknown>>();
	for (const citation of citations) {
		if (!isRecord(citation)) return null;
		if (
			citation.doc_id !== undefined &&
			citation.document_id !== undefined &&
			citation.doc_id !== citation.document_id
		) {
			return null;
		}
		const parsed = MemorySourceReferenceSchema.safeParse({
			doc_id: citation.doc_id ?? citation.document_id,
			document_version_id: citation.document_version_id,
			generation_id: citation.generation_id,
			...(citation.library_id !== undefined
				? { library_id: citation.library_id }
				: {}),
			...(citation.tenant_id !== undefined
				? { tenant_id: citation.tenant_id }
				: {}),
			...(citation.workspace_id !== undefined
				? { workspace_id: citation.workspace_id }
				: {}),
		});
		if (!parsed.success) return null;
		references.set(referenceKey(parsed.data), parsed.data);
		if (references.size > limit) return null;
	}
	return [...references.values()];
}

/** Sources must include selected history dependencies as well as new evidence. */
export function createMemoryProvenance(
	libraryId: string,
	sources: readonly Record<string, unknown>[],
): MemoryProvenance | null {
	const references = sourceReferences(sources);
	if (references === null) return null;
	const parsed = MemoryProvenanceSchema.safeParse({
		version: 1,
		libraryId,
		sourceReferences: references,
	});
	return parsed.success ? parsed.data : null;
}

function exchangeSources(
	provenance: unknown,
	input: Pick<AuthorizationInput, "identity" | "libraryId">,
): Record<string, unknown>[] | null {
	const parsed = MemoryProvenanceSchema.safeParse(provenance);
	if (
		!parsed.success ||
		parsed.data.libraryId !== input.libraryId ||
		parsed.data.sourceReferences.length === 0
	) {
		return null;
	}
	const references = sourceReferences(parsed.data.sourceReferences);
	if (
		references?.some(
			(reference) =>
				(reference.library_id !== undefined &&
					reference.library_id !== input.libraryId) ||
				(reference.tenant_id !== undefined &&
					reference.tenant_id !== input.identity.tenantId) ||
				(reference.workspace_id !== undefined &&
					reference.workspace_id !== input.identity.workspaceId),
		)
	) {
		return null;
	}
	return references;
}

async function authorizeCandidates(
	input: AuthorizationInput & { messages: readonly HistoryCandidate[] },
): Promise<AuthorizedHistory> {
	const exchanges: Exchange[] = [];
	let question: HistoryCandidate | undefined;
	for (const message of input.messages) {
		if (
			!message.complete ||
			typeof message.content !== "string" ||
			message.content.length > 100_000
		) {
			question = undefined;
			continue;
		}
		if (message.role === "user") {
			question = message;
			continue;
		}
		if (message.role === "assistant" && question) {
			const references = exchangeSources(message.provenance, input);
			const userReferences =
				question.provenance === undefined
					? []
					: exchangeSources(question.provenance, input);
			if (references !== null && userReferences !== null) {
				const combined = sourceReferences([...userReferences, ...references]);
				if (combined !== null) {
					exchanges.push({
						messages: [
							{ role: "user", content: question.content },
							{ role: "assistant", content: message.content },
						],
						sourceReferences: combined,
					});
				}
			}
		}
		question = undefined;
	}

	// Keep recent whole exchanges within the dependency budget, never trim lineage.
	const selected: Exchange[] = [];
	let dependencies: Record<string, unknown>[] = [];
	for (let index = exchanges.length - 1; index >= 0; index -= 1) {
		const exchange = exchanges[index];
		const combined = sourceReferences([
			...dependencies,
			...exchange.sourceReferences,
		]);
		if (combined === null) continue;
		selected.push(exchange);
		dependencies = combined;
	}
	if (selected.length === 0) return { messages: [], sourceReferences: [] };

	const allowed = await input.citationAuthorizer.filterAuthorized({
		identity: input.identity,
		libraryId: input.libraryId,
		citations: dependencies,
	});
	const authorized = sourceReferences(allowed);
	if (authorized === null) {
		throw new Error("History authorizer returned invalid source references");
	}
	const allowedKeys = new Set(authorized.map(referenceKey));
	const safe = selected
		.reverse()
		.filter((exchange) =>
			exchange.sourceReferences.every((reference) =>
				allowedKeys.has(referenceKey(reference)),
			),
		);
	const safeReferences = sourceReferences(
		safe.flatMap((exchange) => exchange.sourceReferences),
	);
	if (safeReferences === null) {
		throw new Error("Authorized history exceeded its source reference budget");
	}
	return {
		messages: safe.flatMap((exchange) => exchange.messages),
		sourceReferences: safeReferences,
	};
}

export function authorizeHistory(
	input: AuthorizationInput & { messages: readonly SessionMemoryMessage[] },
): Promise<AuthorizedHistory> {
	return authorizeCandidates({
		...input,
		messages: input.messages.map((message) => ({
			...message,
			complete: true,
		})),
	});
}

/** Only exact server-recorded exchanges may become reusable archived memory. */
export function recoverArchiveProvenance(
	input: Pick<AuthorizationInput, "identity" | "libraryId"> & {
		messages: readonly SessionMemoryMessage[];
		turns: readonly { question: string; answer: string }[];
	},
): (MemoryProvenance | null)[] {
	const matches = new Map<string, MemoryProvenance | null>();
	let question: SessionMemoryMessage | undefined;
	for (const message of input.messages) {
		if (message.role === "user") {
			question = message;
			continue;
		}
		if (question && message.role === "assistant") {
			const key = JSON.stringify([question.content, message.content]);
			const sources = exchangeSources(message.provenance, input);
			const userSources = question.provenance
				? exchangeSources(question.provenance, input)
				: [];
			const previous = matches.get(key);
			matches.set(
				key,
				previous === null || sources === null || userSources === null
					? null
					: createMemoryProvenance(input.libraryId, [
							...(previous?.sourceReferences ?? []),
							...userSources,
							...sources,
						]),
			);
		}
		question = undefined;
	}
	return input.turns.map(
		(turn) => matches.get(JSON.stringify([turn.question, turn.answer])) ?? null,
	);
}

export function authorizeArchivedHistory(
	input: AuthorizationInput & {
		turns: readonly {
			role: string;
			content: string;
			status: string;
			debug?: unknown;
		}[];
	},
): Promise<AuthorizedHistory> {
	return authorizeCandidates({
		...input,
		messages: input.turns.map((turn) => ({
			role: turn.role,
			content: turn.content,
			complete: turn.status === "complete",
			provenance: isRecord(turn.debug)
				? turn.debug.memory_provenance
				: undefined,
		})),
	});
}
