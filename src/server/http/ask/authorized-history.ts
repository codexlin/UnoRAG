import "server-only";
import {
	type PendingClarification,
	readPendingClarification,
} from "@/core/ask-graph/clarification";

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
	messages: {
		role: "user" | "assistant";
		content: string;
		pending_clarification?: PendingClarification;
	}[];
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
	pending_clarification?: unknown;
	history_boundary?: boolean;
};

type Exchange = {
	messages: [
		AuthorizedHistory["messages"][number],
		AuthorizedHistory["messages"][number],
	];
	sourceReferences: Record<string, unknown>[];
};

const MAX_HISTORY_EXCHANGES = 3;
const MAX_HISTORY_CHARS = 8_000;
const COMPACTED_ANSWER = "[回答内容已压缩]";
const MARKDOWN_HEADING = /^ {0,3}#{1,6}\s/;
const MARKDOWN_LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
const FINAL_CITATIONS =
	/(?:\[\d+(?:\s*[,，、–-]\s*\d+)*\]|【(?:来源)?\s*\d+】)(?:[\s。.!！?？]*?(?:\[\d+\]|【(?:来源)?\s*\d+】))*[\s。.!！?？]*$/u;

function isTableDivider(line: string | undefined): line is string {
	return Boolean(
		line?.includes("|") &&
			line
				.trim()
				.replace(/^\||\|$/g, "")
				.split("|")
				.every((cell) => /^:?-+:?$/.test(cell.trim())),
	);
}

function clipHistoryText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= 0) return "";
	// Slice UTF-16 without leaving half of a surrogate pair at the boundary.
	return `${text
		.slice(0, maxChars - 1)
		.replace(/[\uD800-\uDBFF]$/, "")
		.trimEnd()}…`;
}

export function compactHistoryAssistantContent(
	content: string,
	maxChars = 1_200,
): string {
	const limit = Number.isNaN(maxChars) ? 1_200 : Math.floor(maxChars);
	if (content.length <= limit) return content;
	if (limit <= COMPACTED_ANSWER.length + 8)
		return clipHistoryText(content, limit);

	const lines = content.split(/\r?\n/);
	const summary: string[] = [];
	const sections: string[] = [];
	let paragraph: string[] = [];
	let leading = true;
	let closing = "";
	function flushParagraph() {
		if (paragraph.length === 0) return;
		const text = paragraph.join("\n");
		if (leading) summary.push(text);
		else closing = text;
		paragraph = [];
	}

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].trimEnd();
		const divider = lines[index + 1];
		if (line.includes("|") && isTableDivider(divider)) {
			flushParagraph();
			leading = false;
			closing = "";
			const rowStart = index + 2;
			let rowEnd = rowStart;
			while (
				lines[rowEnd]?.includes("|") &&
				!MARKDOWN_HEADING.test(lines[rowEnd])
			) {
				rowEnd += 1;
			}
			const headerBudget = Math.floor(limit / 4);
			const header =
				line.length + divider.length < headerBudget
					? `${line}\n${divider}`
					: clipHistoryText(line, headerBudget);
			sections.push(`${header}\n\n[表格内容已压缩]（${rowEnd - rowStart} 行）`);
			index = rowEnd - 1;
		} else if (MARKDOWN_HEADING.test(line)) {
			flushParagraph();
			closing = "";
			leading = leading && summary.length === 0;
			(leading ? summary : sections).push(line);
		} else if (MARKDOWN_LIST_ITEM.test(line)) {
			flushParagraph();
			leading = false;
			closing = "";
		} else if (line.trim()) {
			paragraph.push(line);
		} else {
			flushParagraph();
		}
	}
	flushParagraph();

	const tailBudget = Math.floor(limit / 4);
	if (!closing && summary.length > 1 && summary.join("\n\n").length > limit) {
		closing = summary.pop() ?? "";
	}
	const finalLine = lines.findLast((line) => line.trim()) ?? "";
	const citations =
		FINAL_CITATIONS.exec(
			finalLine.trimEnd().slice(-Math.min(tailBudget, 300)),
		)?.[0] ?? "";
	const compactTail =
		closing.length <= tailBudget
			? closing || citations
			: [
					clipHistoryText(
						closing,
						tailBudget - (citations ? citations.length + 1 : 0),
					),
					citations,
				]
					.filter(Boolean)
					.join(" ");
	const room =
		limit -
		COMPACTED_ANSWER.length -
		2 -
		(compactTail ? compactTail.length + 2 : 0);
	const head = clipHistoryText(
		summary.join("\n\n"),
		sections.length ? Math.min(Math.floor(limit / 2), room - 2) : room,
	);
	const outlines = clipHistoryText(
		sections.join("\n\n"),
		room - (head ? head.length + 2 : 0),
	);
	return [head, outlines, COMPACTED_ANSWER, compactTail]
		.filter(Boolean)
		.join("\n\n");
}

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
			message.history_boundary === true ||
			!message.complete ||
			typeof message.content !== "string" ||
			message.content.length > 100_000
		) {
			question = undefined;
			exchanges.length = 0;
			continue;
		}
		if (message.role === "user") {
			if (question) exchanges.length = 0;
			question = message;
			continue;
		}
		let accepted = false;
		if (message.role === "assistant" && question) {
			const pending = readPendingClarification(message.pending_clarification);
			if (message.pending_clarification !== undefined && !pending) {
				exchanges.length = 0;
				question = undefined;
				continue;
			}
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
							{
								role: "assistant",
								content: message.content,
								...(pending ? { pending_clarification: pending } : {}),
							},
						],
						sourceReferences: combined,
					});
					accepted = true;
				}
			}
		}
		// A missing exchange is a context boundary, not permission to use an older subject.
		if (!accepted) exchanges.length = 0;
		question = undefined;
	}
	if (question) exchanges.length = 0;

	// Project recent whole exchanges within both budgets, retaining every source
	// dependency even if its citation marker disappears from the compacted text.
	const selected: Exchange[] = [];
	let dependencies: Record<string, unknown>[] = [];
	let remaining = MAX_HISTORY_CHARS;
	for (
		let index = exchanges.length - 1;
		index >= 0 && selected.length < MAX_HISTORY_EXCHANGES;
		index -= 1
	) {
		const exchange = exchanges[index];
		const [user, assistant] = exchange.messages;
		const content = compactHistoryAssistantContent(assistant.content);
		remaining -= user.content.length + content.length;
		if (remaining < 0) break;
		const combined = sourceReferences([
			...dependencies,
			...exchange.sourceReferences,
		]);
		if (combined === null) break;
		selected.push({
			...exchange,
			messages: [user, { ...assistant, content }],
		});
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
	const safe: Exchange[] = [];
	for (const exchange of selected) {
		if (
			!exchange.sourceReferences.every((reference) =>
				allowedKeys.has(referenceKey(reference)),
			)
		)
			break;
		safe.unshift(exchange);
	}
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
	const clarificationKeys = new Set<string>();
	let currentClarificationKey: string | undefined;
	let question: SessionMemoryMessage | undefined;
	for (const [index, message] of input.messages.entries()) {
		if (message.history_boundary) {
			// Clients may omit failed turns when archiving. Do not restore the prefix.
			for (const key of matches.keys()) matches.set(key, null);
			currentClarificationKey = undefined;
			question = undefined;
			continue;
		}
		if (message.role === "user") {
			question = message;
			continue;
		}
		if (question && message.role === "assistant") {
			const key = JSON.stringify([question.content, message.content]);
			if (message.pending_clarification !== undefined) {
				clarificationKeys.add(key);
				if (
					index === input.messages.length - 1 &&
					!matches.has(key) &&
					readPendingClarification(message.pending_clarification)
				)
					currentClarificationKey = key;
			}
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
	return input.turns.map((turn, index) => {
		const key = JSON.stringify([turn.question, turn.answer]);
		// An old or ambiguous choice stays viewable, but null lineage preserves its
		// context boundary instead of letting archived text recreate the candidates.
		if (
			clarificationKeys.has(key) &&
			(key !== currentClarificationKey || index !== input.turns.length - 1)
		)
			return null;
		return matches.get(key) ?? null;
	});
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
			pending_clarification: isRecord(turn.debug)
				? turn.debug.pending_clarification
				: undefined,
		})),
	});
}
