import { tokenize } from "./tokenizer";

export type SparseVector = { indices: number[]; values: number[] };

const encoder = new TextEncoder();

// FNV-1a over UTF-8 is stable across processes; collisions merge term counts.
function termIndex(term: string): number {
	let hash = 0x811c9dc5;
	for (const byte of encoder.encode(term)) {
		hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
	}
	return hash;
}

export function sparseVector(text: string): SparseVector {
	const counts = new Map<number, number>();
	for (const term of tokenize(text)) {
		const index = termIndex(term);
		counts.set(index, (counts.get(index) ?? 0) + 1);
	}
	const indices = [...counts.keys()].sort((a, b) => a - b);
	return {
		indices,
		values: indices.map((index) => 1 + Math.log(counts.get(index) ?? 1)),
	};
}
