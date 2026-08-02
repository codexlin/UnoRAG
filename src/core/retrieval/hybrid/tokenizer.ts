const WORD_PATTERN = /[a-z0-9_]+/giu;
const CJK_PATTERN = /[\u4e00-\u9fff]+/gu;

export function tokenize(text: string): string[] {
	if (!text) return [];
	const normalized = text.toLowerCase();
	const tokens = [...normalized.matchAll(WORD_PATTERN)].map(
		(match) => match[0],
	);
	for (const match of normalized.matchAll(CJK_PATTERN)) {
		const span = match[0];
		tokens.push(...span);
		for (let index = 0; index < span.length - 1; index += 1) {
			tokens.push(span.slice(index, index + 2));
		}
	}
	return tokens;
}
