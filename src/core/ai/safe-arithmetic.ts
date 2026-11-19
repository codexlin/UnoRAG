const MAX_EXPRESSION_LENGTH = 256;
const MAX_DEPTH = 32;

type Token =
	| { kind: "number"; value: number }
	| { kind: "ident"; value: string }
	| { kind: "op"; value: string }
	| { kind: "lparen" }
	| { kind: "rparen" }
	| { kind: "comma" };

export type ArithmeticResult =
	| { ok: true; value: number }
	| { ok: false; error: string };

function tokenize(input: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < input.length) {
		const ch = input[i] ?? "";
		if (/\s/.test(ch)) {
			i += 1;
			continue;
		}
		if (ch === "(") {
			tokens.push({ kind: "lparen" });
			i += 1;
			continue;
		}
		if (ch === ")") {
			tokens.push({ kind: "rparen" });
			i += 1;
			continue;
		}
		if (ch === ",") {
			tokens.push({ kind: "comma" });
			i += 1;
			continue;
		}
		if (ch === "*" && input[i + 1] === "*") {
			tokens.push({ kind: "op", value: "^" });
			i += 2;
			continue;
		}
		if ("+-*/^".includes(ch)) {
			tokens.push({ kind: "op", value: ch });
			i += 1;
			continue;
		}
		if (/[0-9.]/.test(ch)) {
			const match =
				/^(?:\d[\d_]*(?:\.\d[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?/.exec(
					input.slice(i),
				);
			if (!match) {
				throw new Error(`Invalid number near "${input.slice(i, i + 12)}"`);
			}
			const numeric = Number(match[0].replaceAll("_", ""));
			if (!Number.isFinite(numeric)) {
				throw new Error(`Non-finite number "${match[0]}"`);
			}
			tokens.push({ kind: "number", value: numeric });
			i += match[0].length;
			continue;
		}
		if (/[a-zA-Z]/.test(ch)) {
			const match = /^[a-zA-Z]+/.exec(input.slice(i));
			if (!match) throw new Error(`Invalid token near "${ch}"`);
			tokens.push({ kind: "ident", value: match[0].toLowerCase() });
			i += match[0].length;
			continue;
		}
		throw new Error(`Unsupported character "${ch}"`);
	}
	return tokens;
}

class Parser {
	private pos = 0;

	constructor(private readonly tokens: readonly Token[]) {}

	parseExpression(depth = 0): number {
		if (depth > MAX_DEPTH)
			throw new Error("Expression exceeds max nesting depth");
		let value = this.parseTerm(depth + 1);
		while (true) {
			const tok = this.peek();
			if (tok?.kind === "op" && (tok.value === "+" || tok.value === "-")) {
				this.pos += 1;
				const right = this.parseTerm(depth + 1);
				value = tok.value === "+" ? value + right : value - right;
				this.ensureFinite(value);
				continue;
			}
			break;
		}
		return value;
	}

	private parseTerm(depth: number): number {
		if (depth > MAX_DEPTH)
			throw new Error("Expression exceeds max nesting depth");
		let value = this.parsePower(depth + 1);
		while (true) {
			const tok = this.peek();
			if (tok?.kind === "op" && (tok.value === "*" || tok.value === "/")) {
				this.pos += 1;
				const right = this.parsePower(depth + 1);
				if (tok.value === "/") {
					if (right === 0) throw new Error("Division by zero");
					value /= right;
				} else {
					value *= right;
				}
				this.ensureFinite(value);
				continue;
			}
			break;
		}
		return value;
	}

	private parsePower(depth: number): number {
		if (depth > MAX_DEPTH)
			throw new Error("Expression exceeds max nesting depth");
		const base = this.parseUnary(depth + 1);
		const tok = this.peek();
		if (tok?.kind === "op" && tok.value === "^") {
			this.pos += 1;
			const exp = this.parsePower(depth + 1);
			const result = base ** exp;
			this.ensureFinite(result);
			return result;
		}
		return base;
	}

	private parseUnary(depth: number): number {
		if (depth > MAX_DEPTH)
			throw new Error("Expression exceeds max nesting depth");
		const tok = this.peek();
		if (tok?.kind === "op" && (tok.value === "+" || tok.value === "-")) {
			this.pos += 1;
			const operand = this.parseUnary(depth + 1);
			return tok.value === "-" ? -operand : operand;
		}
		return this.parsePrimary(depth + 1);
	}

	private parsePrimary(depth: number): number {
		if (depth > MAX_DEPTH)
			throw new Error("Expression exceeds max nesting depth");
		const tok = this.peek();
		if (!tok) throw new Error("Unexpected end of expression");
		if (tok.kind === "number") {
			this.pos += 1;
			return tok.value;
		}
		if (tok.kind === "lparen") {
			this.pos += 1;
			const value = this.parseExpression(depth + 1);
			const close = this.peek();
			if (close?.kind !== "rparen")
				throw new Error("Missing closing parenthesis");
			this.pos += 1;
			return value;
		}
		if (tok.kind === "ident") {
			const fn = tok.value;
			this.pos += 1;
			if (this.peek()?.kind !== "lparen") {
				throw new Error(`Unexpected identifier "${fn}"`);
			}
			this.pos += 1;
			const args: number[] = [];
			if (this.peek()?.kind !== "rparen") {
				args.push(this.parseExpression(depth + 1));
				while (this.peek()?.kind === "comma") {
					this.pos += 1;
					args.push(this.parseExpression(depth + 1));
				}
			}
			if (this.peek()?.kind !== "rparen") {
				throw new Error(`Missing closing parenthesis after ${fn}(...)`);
			}
			this.pos += 1;
			return this.applyFunction(fn, args);
		}
		throw new Error("Unexpected token in expression");
	}

	private applyFunction(fn: string, args: readonly number[]): number {
		switch (fn) {
			case "sqrt": {
				if (args.length !== 1 || (args[0] ?? -1) < 0) {
					throw new Error("sqrt requires 1 non-negative argument");
				}
				return Math.sqrt(args[0] ?? 0);
			}
			case "abs": {
				if (args.length !== 1) throw new Error("abs requires 1 argument");
				return Math.abs(args[0] ?? 0);
			}
			case "pow": {
				if (args.length !== 2) throw new Error("pow requires 2 arguments");
				const result = (args[0] ?? 0) ** (args[1] ?? 0);
				this.ensureFinite(result);
				return result;
			}
			default:
				throw new Error(`Unsupported function "${fn}"`);
		}
	}

	ensureDone() {
		if (this.pos < this.tokens.length) {
			throw new Error("Unexpected trailing tokens in expression");
		}
	}

	private peek(): Token | undefined {
		return this.tokens[this.pos];
	}

	private ensureFinite(value: number) {
		if (!Number.isFinite(value)) {
			throw new Error("Arithmetic overflow or non-finite result");
		}
	}
}

/** Deterministically evaluate a pure arithmetic expression without eval/Function. */
export function evaluateArithmeticExpression(
	expression: string,
): ArithmeticResult {
	const cleaned = expression.trim().replaceAll(",", "");
	if (!cleaned) return { ok: false, error: "Expression is empty" };
	if (cleaned.length > MAX_EXPRESSION_LENGTH) {
		return {
			ok: false,
			error: `Expression exceeds ${MAX_EXPRESSION_LENGTH} characters`,
		};
	}
	try {
		const tokens = tokenize(cleaned);
		if (tokens.length === 0) return { ok: false, error: "Expression is empty" };
		const parser = new Parser(tokens);
		const value = parser.parseExpression();
		parser.ensureDone();
		return { ok: true, value };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : "Invalid expression",
		};
	}
}
