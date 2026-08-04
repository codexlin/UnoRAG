import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

export const GoldenCaseSchema = z
	.object({
		id: z.string().trim().min(1).optional(),
		file: z.string().trim().min(1),
		mode: z.string().trim().min(1),
		question: z.string().trim().min(1),
		answer: z.string().trim().min(1),
		key_facts: z.array(z.string().trim().min(1)).min(1),
		chunk_hint: z.string().trim().min(1).optional(),
		expect_record_type: z.enum(["text", "table", "image"]).optional(),
	})
	.strict();

export type GoldenCase = z.infer<typeof GoldenCaseSchema> & {
	readonly id: string;
};

export const NegativeGoldenCaseSchema = z
	.object({
		id: z.string().trim().min(1).optional(),
		question: z.string().trim().min(1),
	})
	.strict();

export type NegativeGoldenCase = Readonly<
	z.infer<typeof NegativeGoldenCaseSchema> & { id: string }
>;

const CHINESE_DIGITS: Readonly<Record<string, number>> = {
	零: 0,
	〇: 0,
	一: 1,
	壹: 1,
	二: 2,
	两: 2,
	贰: 2,
	三: 3,
	叁: 3,
	四: 4,
	肆: 4,
	五: 5,
	伍: 5,
	六: 6,
	陆: 6,
	七: 7,
	柒: 7,
	八: 8,
	捌: 8,
	九: 9,
	玖: 9,
};

const CHINESE_UNITS: Readonly<Record<string, number>> = {
	十: 10,
	拾: 10,
	百: 100,
	佰: 100,
	千: 1_000,
	仟: 1_000,
	万: 10_000,
	萬: 10_000,
	亿: 100_000_000,
	億: 100_000_000,
};

const CHINESE_NUMBER_PATTERN =
	/[零〇一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟萬億]+/gu;
const ARABIC_MAGNITUDE_PATTERN = /(?<![\d.])(\d+(?:\.\d+)?)(万|萬|亿|億)/gu;

function parseChineseNumber(value: string): number {
	if (![...value].some((character) => CHINESE_UNITS[character] != null)) {
		return Number(
			[...value].map((character) => CHINESE_DIGITS[character]).join(""),
		);
	}

	let total = 0;
	let section = 0;
	let number = 0;
	for (const character of value) {
		const digit = CHINESE_DIGITS[character];
		if (digit != null) {
			number = digit;
			continue;
		}
		const unit = CHINESE_UNITS[character];
		if (unit == null) throw new Error("unsupported Chinese number character");
		if (unit < 10_000) {
			section += (number || 1) * unit;
		} else {
			section += number;
			total += (section || 1) * unit;
			section = 0;
		}
		number = 0;
	}
	return total + section + number;
}

export function normalizeFactText(value: string): string {
	return value
		.normalize("NFKC")
		.toLocaleLowerCase("en-US")
		.replaceAll(String.raw`\%`, "%")
		.replaceAll("$", "")
		.replace(/[‐‑‒–—−]/gu, "-")
		.replace(/(?<=\d),(?=\d{3}(?:\D|$))/gu, "")
		.replace(
			ARABIC_MAGNITUDE_PATTERN,
			(_match, raw: string, magnitude: string) =>
				String(Number(raw) * (CHINESE_UNITS[magnitude] ?? 1)),
		)
		.replace(CHINESE_NUMBER_PATTERN, (match) =>
			String(parseChineseNumber(match)),
		)
		.replace(/\s+/gu, "");
}

function escapeRegularExpression(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function factMatchesAnswer(fact: string, answer: string): boolean {
	const normalizedFact = normalizeFactText(fact);
	const normalizedAnswer = normalizeFactText(answer);
	if (!normalizedFact) return false;
	let pattern = escapeRegularExpression(normalizedFact);
	if (/^\d/u.test(normalizedFact)) pattern = `(?<![\\d.])${pattern}`;
	if (/\d$/u.test(normalizedFact)) pattern = `${pattern}(?![\\d.])`;
	if (
		new RegExp(`(?:并非|不是|不为|不等于|非)${pattern}`, "u").test(
			normalizedAnswer,
		)
	) {
		return false;
	}
	return new RegExp(pattern, "u").test(normalizedAnswer);
}

function stableCaseId(input: z.infer<typeof GoldenCaseSchema>): string {
	return createHash("sha256")
		.update(`${input.file}\0${input.question}`)
		.digest("hex")
		.slice(0, 16);
}

export function parseGoldenCase(value: unknown): GoldenCase {
	const parsed = GoldenCaseSchema.parse(value);
	const unsupportedFacts = parsed.key_facts.filter(
		(fact) => !factMatchesAnswer(fact, parsed.answer),
	);
	if (unsupportedFacts.length > 0) {
		throw new Error(
			`key_facts not supported by reference answer: ${unsupportedFacts.join(", ")}`,
		);
	}
	return Object.freeze({
		...parsed,
		id: parsed.id ?? stableCaseId(parsed),
		key_facts: Object.freeze([...parsed.key_facts]),
	}) as GoldenCase;
}

export function parseGoldenJsonl(content: string): GoldenCase[] {
	const cases: GoldenCase[] = [];
	for (const [index, line] of content.split(/\r?\n/u).entries()) {
		if (!line.trim()) continue;
		try {
			cases.push(parseGoldenCase(JSON.parse(line)));
		} catch (error) {
			const detail = error instanceof Error ? error.message : "invalid case";
			throw new Error(`invalid gold at line ${index + 1}: ${detail}`, {
				cause: error,
			});
		}
	}
	if (cases.length === 0) throw new Error("golden set must not be empty");
	const ids = new Set<string>();
	for (const item of cases) {
		if (ids.has(item.id))
			throw new Error(`duplicate golden case id: ${item.id}`);
		ids.add(item.id);
	}
	return cases;
}

export async function loadGoldenJsonl(path: string): Promise<GoldenCase[]> {
	return parseGoldenJsonl(await readFile(path, "utf8"));
}

export function parseNegativeGoldenJsonl(
	content: string,
): NegativeGoldenCase[] {
	const cases: NegativeGoldenCase[] = [];
	for (const [index, line] of content.split(/\r?\n/u).entries()) {
		if (!line.trim()) continue;
		try {
			const parsed = NegativeGoldenCaseSchema.parse(JSON.parse(line));
			cases.push(
				Object.freeze({
					...parsed,
					id:
						parsed.id ??
						createHash("sha256")
							.update(parsed.question)
							.digest("hex")
							.slice(0, 16),
				}),
			);
		} catch (error) {
			const detail = error instanceof Error ? error.message : "invalid case";
			throw new Error(`invalid negative gold at line ${index + 1}: ${detail}`, {
				cause: error,
			});
		}
	}
	if (cases.length === 0)
		throw new Error("negative golden set must not be empty");
	if (new Set(cases.map((item) => item.id)).size !== cases.length) {
		throw new Error("negative golden case IDs must be unique");
	}
	return cases;
}

export async function loadNegativeGoldenJsonl(
	path: string,
): Promise<NegativeGoldenCase[]> {
	return parseNegativeGoldenJsonl(await readFile(path, "utf8"));
}
