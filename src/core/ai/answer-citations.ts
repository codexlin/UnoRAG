import { z } from "zod";

export const AnswerCitationDiagnosticSchema = z.object({
	category: z.enum([
		"unknown_source",
		"invalid_format",
		"incomplete_marker",
		"marker_too_long",
	]),
	allowedSourceCount: z.number().int().min(0).max(10_000),
});
export type AnswerCitationDiagnostic = z.infer<
	typeof AnswerCitationDiagnosticSchema
>;

/** Never project the model-authored marker or exception text. */
export function projectAnswerCitationDiagnostic(
	value: unknown,
): AnswerCitationDiagnostic | null {
	const result = AnswerCitationDiagnosticSchema.safeParse(value);
	return result.success ? result.data : null;
}

export class AnswerCitationValidationError extends Error {
	readonly code = "answer_citation_invalid";
	readonly diagnostics: AnswerCitationDiagnostic | null;
	constructor(diagnostics?: AnswerCitationDiagnostic) {
		super("Answer contains an invalid source citation");
		this.name = "AnswerCitationValidationError";
		const safe = projectAnswerCitationDiagnostic(diagnostics);
		this.diagnostics = safe ? Object.freeze(safe) : null;
	}
}

const SOURCE_PREFIX = "[source:";

/** Buffer only a possible citation; model source tokens become public numeric references. */
export class AnswerCitationGuard {
	private pending = "";
	private closed = false;
	private escaped = false;
	private ticks = 0;
	private codeTicks = 0;
	private readonly allowed: Set<number>;

	constructor(
		indices: readonly number[],
		private readonly sourceTokens = false,
	) {
		this.allowed = new Set(indices);
	}

	private fail(category: AnswerCitationDiagnostic["category"]): never {
		throw new AnswerCitationValidationError({
			category,
			allowedSourceCount: this.allowed.size,
		});
	}

	private validate(): string {
		const marker = this.pending;
		const namespaced = this.sourceTokens && marker.startsWith(SOURCE_PREFIX);
		if (
			this.sourceTokens &&
			marker.length > 1 &&
			SOURCE_PREFIX.startsWith(marker)
		)
			this.fail("incomplete_marker");
		let output = marker;
		if (namespaced || /\d/u.test(marker)) {
			const match = namespaced
				? /^\[source:([1-9]\d*)\]$/.exec(marker)
				: /^\[([1-9]\d*)\]$/.exec(marker);
			if (!match)
				this.fail(
					marker.endsWith("]") ? "invalid_format" : "incomplete_marker",
				);
			if (!this.allowed.has(Number(match[1]))) this.fail("unknown_source");
			if (namespaced) output = `[${match[1]}]`;
		}
		this.pending = "";
		this.closed = false;
		return output;
	}

	push(chunk: string): string {
		let output = "";
		for (const character of chunk) {
			if (this.closed) {
				if (
					character === "(" &&
					this.sourceTokens &&
					this.pending.startsWith(SOURCE_PREFIX)
				)
					this.fail("invalid_format");
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
				if (
					this.sourceTokens &&
					(SOURCE_PREFIX.startsWith(this.pending + character) ||
						this.pending.startsWith(SOURCE_PREFIX))
				) {
					this.pending += character;
					if (this.pending.length > 256) this.fail("marker_too_long");
					continue;
				}
				if (/^[\d\s,，、\-–—]$/u.test(character)) {
					this.pending += character;
					if (this.pending.length > 256) this.fail("marker_too_long");
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
