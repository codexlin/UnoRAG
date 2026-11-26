const MAX_SUB_QUERIES = 3;
const MAX_TARGET_LENGTH = 48;
const MAX_QUERY_LENGTH = 140;

const STRIP_PREFIX_RE =
	/^(?:请?结合|请?对比|请?比较|请?分析|请?计算|如果|若|请问|根据资料[，,]?\s*|对于|关于|在|(?:please\s+)?(?:compare|contrast|what\s+(?:is|are)\s+the\s+differences?\s+between|differences?\s+between|between)\s+)/iu;
const CLAUSE_BOUNDARY_RE = /[，,;；。？?\n]+/u;
const STOP_TARGET_RE =
	/^(?:\d{2,4}年?(?:\d{1,2}月?)?|\d{1,2}月份?|方面|情况|原因|趋势|差异|不同|区别|预测|哪个更大|哪个更高|分别是多少|有什么|有哪些|分析|比较|对比|the|difference|differences|comparison)$/iu;

function cleanTarget(raw: string): string {
	return raw
		.replace(STRIP_PREFIX_RE, "")
		.replace(/[“”"'《》()（）]/gu, "")
		.replace(
			/(?:在\d.*|关于.*|方面.*|相比.*|相比较.*|的?(?:主要差异|差异|区别|预测区间|最高点|信息|情况|数据|表现|波动原因).*)$/u,
			"",
		)
		.trim();
}

function isUsableTarget(target: string): boolean {
	if (target.length < 2 || target.length > MAX_TARGET_LENGTH) return false;
	if (STOP_TARGET_RE.test(target)) return false;
	return /[\p{L}\p{N}]/u.test(target);
}

function splitCoordinatedTargets(clause: string): string[] {
	const trimmedClause = clause.replace(
		/(?:在\d.*|关于.*|方面.*|相比.*|相比较.*|的?(?:主要差异|差异|区别|预测区间|最高点|价格波动|哪个|谁更|分别是|各自).*|\s+(?:on|in|for|regarding|about)\s+.*)$/iu,
		"",
	);
	const englishCompareSplit = /\b(?:compare|contrast|between)\b/i.test(
		trimmedClause,
	);
	const splitter = englishCompareSplit
		? /\s*(?:、|\s+(?:vs\.?|versus|and)\s+|与|和|及|以及|跟|同)\s*/iu
		: /\s*(?:、|\s+(?:vs\.?|versus)\s+|与|和|及|以及|跟|同)\s*/iu;
	const parts = trimmedClause
		.split(splitter)
		.map(cleanTarget)
		.filter(isUsableTarget);
	const unique: string[] = [];
	for (const part of parts) {
		if (!unique.includes(part)) unique.push(part);
	}
	return unique;
}

function extractContextTail(
	question: string,
	targets: readonly string[],
): string {
	let remainder = question;
	for (const target of targets) {
		remainder = remainder.replaceAll(target, " ");
	}
	return remainder
		.replace(
			/(?:哪[个一]|分别是多少|有什么|有哪些|主要差异|之间的?(?:差异|区别|对比)|相比较?|对比|结合|关于|方面|和|与|、|[？?，,。；;]|\b(?:please|compare|contrast|between|versus|vs\.?|and|what|is|are|the|differences?|on|in|for|regarding|about)\b)/giu,
			" ",
		)
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, 60);
}

/**
 * Extract balanced per-target sub-queries for multi-entity comparison questions
 * so single-vector retrieval does not drop one side of a comparison.
 */
export function buildComparisonSubQueries(question: string): string[] {
	const trimmed = question.trim();
	if (!trimmed) return [];

	const clauses = trimmed
		.split(CLAUSE_BOUNDARY_RE)
		.map((part) => part.trim())
		.filter(Boolean);
	let targets: string[] = [];
	for (const clause of clauses) {
		const candidate = splitCoordinatedTargets(clause);
		if (candidate.length >= 2) {
			targets = candidate;
			break;
		}
	}
	if (targets.length < 2) return [];

	const boundedTargets = targets.slice(0, MAX_SUB_QUERIES);
	const tail = extractContextTail(trimmed, boundedTargets);
	return boundedTargets.map((target) =>
		(tail ? `${target} ${tail}` : target).slice(0, MAX_QUERY_LENGTH).trim(),
	);
}

/**
 * Split multi-subquestion planning/multi-hop prompts joined by coordinating
 * conjunctions into up to 2 complementary retrieval queries.
 */
export function buildMultiAspectSubQueries(question: string): string[] {
	const trimmed = question.trim();
	if (trimmed.length < 16) return [];
	const parts = trimmed
		.split(/\s*(?:并且|以及|且|同时|[，,;；])\s*/u)
		.map((part) => part.replace(/[？?。！!]+$/gu, "").trim())
		.filter((part) => part.length >= 6);
	if (parts.length < 2) return [];
	const subjectMatch = trimmed.match(
		/^([A-Za-z0-9_\u4e00-\u9fa5]{2,20})(?:在|的|对于|关于|中)/u,
	);
	const subject = subjectMatch?.[1]?.trim() ?? "";
	const unique: string[] = [];
	for (const part of parts) {
		const candidate = (
			subject && !part.includes(subject) ? `${subject} ${part}` : part
		)
			.slice(0, MAX_QUERY_LENGTH)
			.trim();
		if (candidate.length >= 6 && !unique.includes(candidate)) {
			unique.push(candidate);
		}
		if (unique.length >= 2) break;
	}
	return unique.length >= 2 ? unique : [];
}

/**
 * Interleave baseline retrieval hits with per-target sub-query hits round-robin,
 * preserving highest-ranked global hits first while guaranteeing coverage across targets.
 */
export function mergeComparisonCitations<T extends { id: string }>(
	primary: readonly T[],
	subLists: readonly (readonly T[])[],
	limit: number,
): T[] {
	if (limit <= 0) return [];
	if (subLists.length === 0) return primary.slice(0, limit);

	const merged: T[] = [];
	const seen = new Set<string>();
	const push = (item: T | undefined) => {
		if (!item || seen.has(item.id) || merged.length >= limit) return false;
		seen.add(item.id);
		merged.push(item);
		return true;
	};

	// Keep top anchors from the full-question query first.
	const initialPrimary = Math.min(4, primary.length);
	for (let i = 0; i < initialPrimary; i += 1) {
		push(primary[i]);
	}

	// Round-robin across sub-query lists and remaining primary hits.
	const queues: readonly (readonly T[])[] = [
		...subLists,
		primary.slice(initialPrimary),
	];
	const maxLen = Math.max(0, ...queues.map((list) => list.length));
	for (let rank = 0; rank < maxLen && merged.length < limit; rank += 1) {
		for (const list of queues) {
			push(list[rank]);
			if (merged.length >= limit) break;
		}
	}
	return merged;
}
