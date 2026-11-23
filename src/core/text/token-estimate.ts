const TOKEN_UNITS = 100;
const LATIN = /\p{Script=Latin}/u;
const WHITESPACE = /\s/u;
const WORD_BOUNDARY = /\s+/gu;
const SENTENCE_BOUNDARY = /[。！？；]+|[.!?;]+(?=\s)/gu;

function tokenUnits(character: string): number {
	const code = character.charCodeAt(0);
	if (
		(code >= 48 && code <= 57) ||
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122)
	) {
		return 28;
	}
	if (WHITESPACE.test(character)) return 16;
	if (code < 128) return 65;
	if (LATIN.test(character)) return 28;
	// CJK, including supplementary-plane Han and CJK punctuation, costs one
	// token per code point. Other non-Latin characters use the same estimate.
	return TOKEN_UNITS;
}

export function estimateTokens(text: string): number {
	let units = 0;
	for (const character of text) units += tokenUnits(character);
	return Math.ceil(units / TOKEN_UNITS);
}

export function sliceByTokenBudget(
	text: string,
	maxTokens: number,
	hardMaxChars = Number.POSITIVE_INFINITY,
): string {
	let end = 0;
	let remaining = Math.floor(maxTokens) * TOKEN_UNITS;
	for (const character of text) {
		remaining -= tokenUnits(character);
		if (remaining < 0 || end + character.length > hardMaxChars) break;
		end += character.length;
	}
	const prefix = text.slice(0, end);
	if (end === text.length || end === 0) return prefix;

	// Prefer a nearby sentence or word break without removing too much text.
	const minimum = Math.max(1, Math.ceil(end * 0.9));
	for (const pattern of [SENTENCE_BOUNDARY, WORD_BOUNDARY]) {
		let boundary = 0;
		for (const match of prefix.matchAll(pattern)) {
			boundary = match.index + match[0].length;
		}
		if (boundary >= minimum) return prefix.slice(0, boundary);
	}
	return prefix;
}

export function sliceTailByTokenBudget(
	text: string,
	maxTokens: number,
	hardMaxChars = Number.POSITIVE_INFINITY,
): string {
	let start = text.length;
	let remaining = Math.floor(maxTokens) * TOKEN_UNITS;
	while (start > 0) {
		const last = text.charCodeAt(start - 1);
		const previous = text.charCodeAt(start - 2);
		const width =
			last >= 0xdc00 &&
			last <= 0xdfff &&
			previous >= 0xd800 &&
			previous <= 0xdbff
				? 2
				: 1;
		remaining -= tokenUnits(text.slice(start - width, start));
		if (remaining < 0 || text.length - start + width > hardMaxChars) break;
		start -= width;
	}
	// Include the original separator so adjacent slices can be joined verbatim.
	const suffix = text.slice(start);
	const boundary = suffix.search(WHITESPACE);
	return start > 0 && boundary >= 0 && boundary <= suffix.length * 0.1
		? suffix.slice(boundary)
		: suffix;
}

/** Keep a verbatim anchor and share the remaining budget across both sides. */
export function sliceAroundTokenBudget(
	text: string,
	start: number,
	end: number,
	maxTokens: number,
	hardMaxChars: number,
): string {
	const anchor = text.slice(start, end);
	if (anchor.length > hardMaxChars || estimateTokens(anchor) > maxTokens) {
		return sliceByTokenBudget(anchor, maxTokens, hardMaxChars);
	}
	const before = text.slice(0, start);
	const after = text.slice(end);
	const tokens = maxTokens - estimateTokens(anchor);
	const chars = hardMaxChars - anchor.length;
	let left = sliceTailByTokenBudget(
		before,
		Math.floor(tokens / 2),
		Math.floor(chars / 2),
	);
	const right = sliceByTokenBudget(
		after,
		tokens - estimateTokens(left),
		chars - left.length,
	);
	if (right.length === after.length) {
		left = sliceTailByTokenBudget(
			before,
			tokens - estimateTokens(right),
			chars - right.length,
		);
	}
	return left + anchor + right;
}
