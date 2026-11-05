export class AnswerCitationValidationError extends Error {
	readonly code = "answer_citation_invalid";
	constructor() {
		super("Answer contains an invalid source citation");
		this.name = "AnswerCitationValidationError";
	}
}

/** Hold only a possible numeric citation, not the answer or the model stream. */
export class AnswerCitationGuard {
	private pending = "";
	private closed = false;
	private escaped = false;
	private ticks = 0;
	private codeTicks = 0;
	private readonly allowed: Set<number>;

	constructor(indices: readonly number[]) {
		this.allowed = new Set(indices);
	}

	private validate(): string {
		const marker = this.pending;
		if (/\d/u.test(marker)) {
			const match = /^\[([1-9]\d*)\]$/.exec(marker);
			if (!match || !this.allowed.has(Number(match[1]))) {
				throw new AnswerCitationValidationError();
			}
		}
		this.pending = "";
		this.closed = false;
		return marker;
	}

	push(chunk: string): string {
		let output = "";
		for (const character of chunk) {
			if (this.closed) {
				// A numeric Markdown link label is not a source citation.
				if (character === "(") {
					output += this.pending;
					this.pending = "";
					this.closed = false;
				} else output += this.validate();
			}
			if (this.pending) {
				if (character === "]") {
					this.pending += character;
					this.closed = true;
					continue;
				}
				if (/^[\d\s,，、\-–—]$/u.test(character)) {
					this.pending += character;
					if (this.pending.length > 256)
						throw new AnswerCitationValidationError();
					continue;
				}
				output += this.pending;
				this.pending = "";
			}
			if (character === "`" && !this.escaped) {
				this.ticks += 1;
				output += character;
				continue;
			}
			if (this.ticks) {
				if (!this.codeTicks) this.codeTicks = this.ticks;
				else if (this.codeTicks === this.ticks) this.codeTicks = 0;
				this.ticks = 0;
			}
			if (character === "[" && !this.codeTicks && !this.escaped) {
				this.pending = "[";
			} else output += character;
			this.escaped = character === "\\" && !this.escaped;
		}
		return output;
	}

	finish(): string {
		return this.validate();
	}
}
