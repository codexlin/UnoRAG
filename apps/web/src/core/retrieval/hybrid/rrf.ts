export type RankedItem<T> = {
	id: string;
	value: T;
};

export type FusedItem<T> = RankedItem<T> & {
	score: number;
};

export function reciprocalRankFusion<T>(
	rankedLists: RankedItem<T>[][],
	options?: { k?: number; limit?: number },
): FusedItem<T>[] {
	const k = options?.k ?? 60;
	const byId = new Map<string, FusedItem<T>>();
	for (const ranked of rankedLists) {
		ranked.forEach((item, index) => {
			const existing = byId.get(item.id);
			const contribution = 1 / (k + index + 1);
			if (existing) {
				existing.score += contribution;
			} else {
				byId.set(item.id, { ...item, score: contribution });
			}
		});
	}
	return [...byId.values()]
		.sort((left, right) => right.score - left.score)
		.slice(0, options?.limit);
}
