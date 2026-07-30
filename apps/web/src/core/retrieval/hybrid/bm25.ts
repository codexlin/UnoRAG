import { tokenize } from "./tokenizer";

export type Bm25Document<T> = {
	id: string;
	text: string;
	value: T;
};

export type Bm25Hit<T> = Bm25Document<T> & {
	score: number;
};

export class Bm25Index<T> {
	private readonly tokenized: string[][];
	private readonly frequencies: Map<string, number>[];
	private readonly inverseDocumentFrequency: Map<string, number>;
	private readonly averageLength: number;

	constructor(
		private readonly documents: Bm25Document<T>[],
		private readonly k1 = 1.5,
		private readonly b = 0.75,
	) {
		this.tokenized = documents.map((document) => tokenize(document.text));
		this.frequencies = this.tokenized.map((tokens) => {
			const frequencies = new Map<string, number>();
			for (const token of tokens) {
				frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
			}
			return frequencies;
		});
		this.averageLength = this.tokenized.length
			? this.tokenized.reduce((total, tokens) => total + tokens.length, 0) /
				this.tokenized.length
			: 0;
		const documentFrequency = new Map<string, number>();
		for (const frequencies of this.frequencies) {
			for (const token of frequencies.keys()) {
				documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
			}
		}
		this.inverseDocumentFrequency = new Map(
			[...documentFrequency].map(([token, frequency]) => [
				token,
				Math.log(
					1 + (this.documents.length - frequency + 0.5) / (frequency + 0.5),
				),
			]),
		);
	}

	search(query: string, topK: number): Bm25Hit<T>[] {
		const queryFrequency = new Map<string, number>();
		for (const token of tokenize(query)) {
			queryFrequency.set(token, (queryFrequency.get(token) ?? 0) + 1);
		}
		const scored = this.documents.map((document, index) => {
			let score = 0;
			for (const [token, queryCount] of queryFrequency) {
				const frequency = this.frequencies[index]?.get(token) ?? 0;
				const idf = this.inverseDocumentFrequency.get(token);
				if (!frequency || idf === undefined) continue;
				const length = this.tokenized[index]?.length ?? 0;
				const denominator =
					frequency +
					this.k1 *
						(1 - this.b + (this.b * length) / (this.averageLength || 1));
				score += idf * ((frequency * (this.k1 + 1)) / denominator) * queryCount;
			}
			return { ...document, score };
		});
		return scored
			.filter((item) => item.score > 0)
			.sort((left, right) => right.score - left.score)
			.slice(0, topK);
	}
}
