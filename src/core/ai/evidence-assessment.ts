import { validateConflictEvidence } from "../ask-graph/evidence-conflict";
import type { AskState } from "../ask-graph/state";
import type {
	StructuredOutputAdapter,
	StructuredRequestMetadata,
} from "./structured-output";

type Adapter = Pick<
	StructuredOutputAdapter,
	"judgeWithMetadata" | "checkConflictWithMetadata"
>;
type Input = Parameters<Adapter["judgeWithMetadata"]>[0] & {
	query_type?: string;
};
type Options = Parameters<Adapter["judgeWithMetadata"]>[1];

function conflictCandidates(input: Input, evidenceIds: string[]) {
	const sources = input.citations as Array<{
		id?: string;
		doc_id?: string;
		document_identity?: string[];
	}>;
	const selected = sources.filter(
		(item) => item.id && evidenceIds.includes(item.id),
	);
	const documents = new Set(
		selected.flatMap((item) => (item.doc_id ? [item.doc_id] : [])),
	);
	const identities = new Set(
		selected.flatMap((item) => item.document_identity ?? []),
	);
	// A pronoun in an unrelated document is not proof of shared business scope.
	// Explicit multi-document selections and shared document numbers remain eligible.
	return sources.filter(
		(item) =>
			documents.size === 0 ||
			(item.doc_id && documents.has(item.doc_id)) ||
			item.document_identity?.some((id) => identities.has(id)),
	);
}

function sumMetadata(
	a: StructuredRequestMetadata,
	b: StructuredRequestMetadata,
): StructuredRequestMetadata {
	return {
		attempts: a.attempts + b.attempts,
		durationMs: Math.round((a.durationMs + b.durationMs) * 100) / 100,
		...Object.fromEntries(
			(["inputTokens", "outputTokens", "totalTokens"] as const)
				.filter((key) => a[key] !== undefined && b[key] !== undefined)
				.map((key) => [key, (a[key] ?? 0) + (b[key] ?? 0)]),
		),
	};
}

/** Sufficiency owns evidence selection. Conflict verification may only add verified opposing evidence. */
export async function assessEvidenceWithMetadata(
	adapter: Adapter,
	input: Input,
	options: Options = {},
) {
	const judged = await adapter.judgeWithMetadata(input, options);
	const base = {
		...judged.output,
		evidence_resolution: "not_checked",
		conflict_evidence: [] as ReturnType<typeof validateConflictEvidence>,
		judge_sufficiency_attempts: judged.metadata.attempts,
		judge_sufficiency_duration_ms: judged.metadata.durationMs,
		judge_conflict_attempts: 0,
		judge_conflict_duration_ms: 0,
	};
	if (!judged.output.sufficient || judged.output.action !== "generate") {
		return { output: base, metadata: judged.metadata };
	}
	// Comparing distinct subjects is not a same-fact conflict check. Keep the
	// established comparison/summary evidence contracts until a dedicated verifier exists.
	if (input.query_type && !["fact", "follow_up"].includes(input.query_type)) {
		return { output: base, metadata: judged.metadata };
	}
	const ids = new Set(
		input.citations.map((item) => (item as { id?: unknown })?.id),
	);
	if (
		!judged.output.evidence_ids.length ||
		judged.output.evidence_ids.some((id) => !ids.has(id))
	) {
		throw new Error("Invalid selected evidence");
	}
	const candidates = conflictCandidates(input, judged.output.evidence_ids);
	const checked = await adapter.checkConflictWithMetadata(
		{
			question: input.question,
			query_type: input.query_type,
			citations: candidates,
			evidence_ids: judged.output.evidence_ids,
		},
		options,
	);
	const excerpts = validateConflictEvidence(
		checked.output.conflict_evidence,
		candidates as AskState["citations"],
	);
	const selected = [
		...new Set([
			...judged.output.evidence_ids,
			...excerpts.map((item) => item.evidence_id),
		]),
	];
	if (selected.length > 6)
		throw new Error("Too many selected evidence sources");
	return {
		output: {
			...base,
			evidence_ids: excerpts.length ? selected : judged.output.evidence_ids,
			reason: excerpts.length ? "evidence_conflict" : judged.output.reason,
			evidence_resolution: checked.output.resolution,
			conflict_scope: "selected_documents",
			conflict_candidate_count: candidates.length,
			conflict_evidence: excerpts,
			judge_conflict_attempts: checked.metadata.attempts,
			judge_conflict_duration_ms: checked.metadata.durationMs,
		},
		metadata: sumMetadata(judged.metadata, checked.metadata),
	};
}
