import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

export const QualityDimensionSchema = z.enum([
	"cross_page_table",
	"low_contrast_scan",
]);

export type QualityDimension = z.infer<typeof QualityDimensionSchema>;

const FixtureFilenameSchema = z
	.string()
	.min(1)
	.max(255)
	.refine(
		(value) =>
			value === value.trim() &&
			value !== "." &&
			value !== ".." &&
			!/[\\/:\p{Cc}]/u.test(value),
		"file must be a fixture basename, not a path",
	);
const ExpectedRecordTypeSchema = z.enum(["text", "table", "image"]);
const KeyFactsSchema = z
	.array(z.string().trim().min(1).max(512))
	.min(1)
	.max(64);
const AnswerCheckFactSchema = z.string().trim().min(1).max(512).optional();
const AnswerCheckSchema = z.union([
	z
		.object({
			label: z.string().trim().min(1).max(120),
			any_of: KeyFactsSchema,
			for_fact: AnswerCheckFactSchema,
		})
		.strict(),
	z
		.object({
			label: z.string().trim().min(1).max(120),
			none_of: KeyFactsSchema,
			for_fact: AnswerCheckFactSchema,
		})
		.strict(),
]);
const AnswerFactAliasesSchema = z
	.object({
		fact: z.string().trim().min(1).max(512),
		any_of: KeyFactsSchema.max(12),
	})
	.strict();
const SupportingSourceSchema = z
	.object({
		file: FixtureFilenameSchema,
		key_facts: KeyFactsSchema,
		expect_record_type: ExpectedRecordTypeSchema,
	})
	.strict();

export const GoldenCaseSchema = z
	.object({
		id: z.string().trim().min(1).optional(),
		file: FixtureFilenameSchema,
		mode: z.string().trim().min(1),
		question: z.string().trim().min(1),
		answer: z.string().trim().min(1),
		key_facts: KeyFactsSchema,
		chunk_hint: z.string().trim().min(1).optional(),
		expect_record_type: ExpectedRecordTypeSchema.optional(),
		expect_conflict: z.boolean().optional(),
		answer_checks: z.array(AnswerCheckSchema).min(1).max(16).optional(),
		answer_fact_aliases: z
			.array(AnswerFactAliasesSchema)
			.min(1)
			.max(16)
			.optional(),
		require_citation_facts: z.literal(true).optional(),
		supporting_sources: z
			.array(SupportingSourceSchema)
			.min(1)
			.max(8)
			.optional(),
		quality_dimensions: z.array(QualityDimensionSchema).default([]),
	})
	.strict()
	.superRefine((value, context) => {
		const uniqueFacts = (facts: string[]) =>
			new Set(facts.map(normalizeFactText)).size === facts.length;
		if (!uniqueFacts(value.key_facts)) {
			context.addIssue({ code: "custom", message: "duplicate key_facts" });
		}
		if (
			(value.supporting_sources || value.require_citation_facts) &&
			!value.expect_record_type
		) {
			context.addIssue({
				code: "custom",
				message: "citation fact verification requires expect_record_type",
			});
		}
		const labels = new Set<string>();
		for (const check of value.answer_checks ?? []) {
			const phrases = "any_of" in check ? check.any_of : check.none_of;
			if (labels.has(check.label) || !uniqueFacts(phrases)) {
				context.addIssue({
					code: "custom",
					message: "duplicate answer check label or phrase",
				});
			}
			labels.add(check.label);
			if (check.for_fact && !value.key_facts.includes(check.for_fact)) {
				context.addIssue({
					code: "custom",
					message: `answer check must refer to a key_fact: ${check.label}`,
				});
			}
			if (!answerCheckMatches(check, value.answer, value.key_facts)) {
				context.addIssue({
					code: "custom",
					message: `reference answer fails check: ${check.label}`,
				});
			}
		}
		const aliasedFacts = new Set<string>();
		for (const { fact, any_of } of value.answer_fact_aliases ?? []) {
			if (
				!value.require_citation_facts ||
				!value.key_facts.includes(fact) ||
				aliasedFacts.has(fact) ||
				!uniqueFacts([fact, ...any_of])
			) {
				context.addIssue({
					code: "custom",
					message:
						"answer fact aliases require a unique key_fact, unique aliases and require_citation_facts",
				});
			}
			aliasedFacts.add(fact);
		}
		const files = new Set([value.file]);
		for (const source of value.supporting_sources ?? []) {
			if (files.has(source.file)) {
				context.addIssue({
					code: "custom",
					message: "duplicate supporting source or primary file",
				});
			}
			files.add(source.file);
			if (
				!uniqueFacts(source.key_facts) ||
				source.key_facts.some((fact) => !value.key_facts.includes(fact))
			) {
				context.addIssue({
					code: "custom",
					message:
						"supporting key_facts must be a unique subset of case key_facts",
				});
			}
		}
	});

export type GoldenCase = z.infer<typeof GoldenCaseSchema> & {
	readonly id: string;
};

export const NegativeGoldenCaseSchema = z
	.object({
		id: z.string().trim().min(1).optional(),
		question: z.string().trim().min(1),
		refusal_evidence: z
			.object({
				min_retrieved: z.number().int().min(1).max(20),
				reason_contains: z.array(KeyFactsSchema.max(12)).min(1).max(8),
			})
			.strict()
			.optional(),
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

const CHINESE_DIGIT_CHARS = Object.keys(CHINESE_DIGITS).join("");
const CHINESE_NUMBER_CHARS =
	CHINESE_DIGIT_CHARS + Object.keys(CHINESE_UNITS).join("");
const CHINESE_NUMBER_PATTERN = new RegExp(`[${CHINESE_NUMBER_CHARS}]+`, "gu");
const SPELLED_PERCENT_PATTERN = new RegExp(
	String.raw`百分之\s*(?:(\d+(?:\.\d+)?)|([${CHINESE_NUMBER_CHARS}]+)(?:[点點]([${CHINESE_DIGIT_CHARS}]+))?)(?![\d${CHINESE_NUMBER_CHARS}点點%]|\.\d)`,
	"gu",
);
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
			SPELLED_PERCENT_PATTERN,
			(
				_match,
				arabic: string | undefined,
				integer: string,
				fraction?: string,
			) => {
				if (arabic !== undefined) return `${arabic}%`;
				const decimals = fraction
					? `.${[...fraction].map((digit) => CHINESE_DIGITS[digit]).join("")}`
					: "";
				return `${parseChineseNumber(integer)}${decimals}%`;
			},
		)
		.replace(
			ARABIC_MAGNITUDE_PATTERN,
			(_match, raw: string, magnitude: string) =>
				String(Number(raw) * (CHINESE_UNITS[magnitude] ?? 1)),
		)
		.replace(CHINESE_NUMBER_PATTERN, (match) =>
			String(parseChineseNumber(match)),
		)
		.replace(
			/(?<![\d.])(\d+)\.(\d+)(?![\d.])/gu,
			(_match, integer: string, fraction: string) => {
				const significantFraction = fraction.replace(/0+$/u, "");
				return significantFraction
					? `${integer}.${significantFraction}`
					: integer;
			},
		)
		.replace(/\s+/gu, "");
}

function escapeRegularExpression(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function factMatchesAnswer(
	fact: string,
	answer: string,
	options?: { affirmativeAction?: boolean },
): boolean {
	const normalizedFact = normalizeFactText(fact);
	const normalizedAnswer = normalizeFactText(answer);
	if (!normalizedFact) return false;
	let pattern = escapeRegularExpression(normalizedFact);
	if (/^\d/u.test(normalizedFact)) pattern = `(?<![\\d.])${pattern}`;
	if (/\d$/u.test(normalizedFact)) pattern = `${pattern}(?![\\d.])`;
	const negations = ["并非", "不是", "不为", "不等于", "非"];
	for (const match of normalizedAnswer.matchAll(new RegExp(pattern, "gu"))) {
		const prefix = normalizedAnswer.slice(0, match.index);
		if (negations.some((negation) => prefix.endsWith(negation))) continue;
		if (
			options?.affirmativeAction &&
			/(?:无需|无须|不需要|不必|不用|不应|不得|不要|禁止)(?:再|额外|进行|做|完成|执行)*$/u.test(
				prefix,
			)
		)
			continue;
		return true;
	}
	return false;
}

export function answerFactMatches(
	fact: string,
	answer: string,
	aliases?: readonly string[],
): boolean {
	if (!aliases) return factMatchesAnswer(fact, answer);
	const text = answer.replace(/[*_`"'“”‘’「」《》]/gu, "");
	return [fact, ...aliases].some((phrase) =>
		factMatchesAnswer(phrase, text, { affirmativeAction: true }),
	);
}

function clausesForFacts(text: string, facts: readonly string[]): string[] {
	const clauses: string[] = [];
	const content = text.normalize("NFKC").replace(/\[[1-9]\d*\]/gu, "");
	const boundaries =
		/[()]|[\r\n。;!?]+|(?<!\d)\.|\.(?!\d)|(?<!\d),|,(?!\d{3}(?:\D|$))/gu;
	let depth = 0;
	let start = 0;
	let first = 0;
	const finishSentence = (end: number) => {
		const fragment = content.slice(start, end);
		if (facts.some((fact) => factMatchesAnswer(fact, fragment))) {
			clauses.push(fragment);
		} else if (fragment.trim() && clauses.length > first) {
			clauses[clauses.length - 1] += `,${fragment}`;
		}
		first = clauses.length;
	};
	for (const match of content.matchAll(boundaries)) {
		const token = match[0];
		if (token === "(") {
			depth += 1;
		} else if (token === ")") {
			depth = Math.max(0, depth - 1);
		} else if (depth === 0) {
			if (token === ",") {
				// Keep a lead-in such as "at peak hours," with its following fact.
				const fragment = content.slice(start, match.index);
				if (!facts.some((fact) => factMatchesAnswer(fact, fragment))) continue;
				clauses.push(fragment);
			} else {
				finishSentence(match.index);
			}
			start = match.index + token.length;
		}
	}
	finishSentence(content.length);
	return clauses;
}

export function answerCheckMatches(
	check: z.infer<typeof AnswerCheckSchema>,
	answer: string,
	facts: readonly string[],
): boolean {
	const text = answer.replace(/[*_`"'“”‘’「」《》]/gu, "");
	const fact = check.for_fact;
	const scopes = fact
		? clausesForFacts(text, facts).filter((clause) =>
				factMatchesAnswer(fact, clause),
			)
		: [text];
	if (!scopes.length) return false;
	const includes = (phrase: string) =>
		scopes.some((scope) => factMatchesAnswer(phrase, scope));
	return "any_of" in check
		? check.any_of.some(includes)
		: !check.none_of.some(includes);
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
		...(parsed.answer_fact_aliases
			? {
					answer_fact_aliases: Object.freeze(
						parsed.answer_fact_aliases.map((entry) =>
							Object.freeze({
								...entry,
								any_of: Object.freeze([...entry.any_of]),
							}),
						),
					),
				}
			: {}),
		...(parsed.answer_checks
			? {
					answer_checks: Object.freeze(
						parsed.answer_checks.map((check) =>
							Object.freeze(
								"any_of" in check
									? { ...check, any_of: Object.freeze([...check.any_of]) }
									: { ...check, none_of: Object.freeze([...check.none_of]) },
							),
						),
					),
				}
			: {}),
		quality_dimensions: Object.freeze([...parsed.quality_dimensions]),
		...(parsed.supporting_sources
			? {
					supporting_sources: Object.freeze(
						parsed.supporting_sources.map((source) =>
							Object.freeze({
								...source,
								key_facts: Object.freeze([...source.key_facts]),
							}),
						),
					),
				}
			: {}),
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
