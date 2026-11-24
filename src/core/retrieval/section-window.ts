import { estimateTokens } from "../text/token-estimate";
import type { QdrantSearchHit } from "./qdrant/payload";

export type SectionHeadingStructure =
	| {
			kind: "decimal";
			decimalParts: readonly string[];
			normalizedLeaf: string;
			trailingArabicOrdinal?: number;
	  }
	| {
			kind: "arabic_item" | "cn_item" | "cn_paren_item";
			ordinal: number;
			normalizedLeaf: string;
	  };

const NON_CHAPTER_UNIT_FOLLOWERS =
	/^(?:年|月|日|%|％|亿|万|千|百|元|倍|个|项|家|套|名|条|页|次|天|小时|分钟|秒|季度|周|岁|人|户|笔|股|亿元|万元|百万元)/u;

const CHINESE_DIGITS: Readonly<Record<string, number>> = {
	一: 1,
	二: 2,
	三: 3,
	四: 4,
	五: 5,
	六: 6,
	七: 7,
	八: 8,
	九: 9,
};

function parseChineseOrdinal(raw: string): number | null {
	if (!raw) return null;
	if (raw === "十") return 10;
	if (raw.length === 1) return CHINESE_DIGITS[raw] ?? null;
	if (raw.startsWith("十") && raw.length === 2) {
		const ones = CHINESE_DIGITS[raw[1] ?? ""];
		return ones ? 10 + ones : null;
	}
	if (raw.endsWith("十") && raw.length === 2) {
		const tens = CHINESE_DIGITS[raw[0] ?? ""];
		return tens ? tens * 10 : null;
	}
	if (raw.length === 3 && raw[1] === "十") {
		const tens = CHINESE_DIGITS[raw[0] ?? ""];
		const ones = CHINESE_DIGITS[raw[2] ?? ""];
		return tens && ones ? tens * 10 + ones : null;
	}
	return null;
}

function leafHeading(
	sectionPath: string | null | undefined,
	headingText?: string | null,
): string {
	const fromPath = sectionPath
		?.split("/")
		.map((part) => part.trim())
		.filter(Boolean)
		.at(-1);
	const raw = fromPath || headingText?.trim() || "";
	return raw.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function parseSectionHeadingStructure(
	sectionPath: string | null | undefined,
	headingText?: string | null,
): SectionHeadingStructure | null {
	const leaf = leafHeading(sectionPath, headingText);
	if (!leaf) return null;
	const normalizedLeaf = leaf.toLowerCase();

	// Multi-level decimal heading, e.g. "4.2 ...", "1.1.1 ...", "2.3 ... 2.3.1 ...", "5.2 ... 1. ..."
	const leadingDecimal = leaf.match(
		/^([1-9]\d?(?:\.[1-9]\d?){1,3})(?=[\s、.．:：）)\p{Script=Han}A-Za-z])/u,
	);
	if (leadingDecimal?.[1]) {
		let decimal = leadingDecimal[1];
		const rest = leaf.slice(decimal.length);
		const escaped = decimal.replaceAll(".", "\\.");
		const embeddedSub = rest.match(
			new RegExp(
				`\\s+(${escaped}\\.[1-9]\\d?(?:\\.[1-9]\\d?){0,2})(?=[\\s、.．:：）)\\p{Script=Han}A-Za-z])`,
				"u",
			),
		);
		if (embeddedSub?.[1]) {
			decimal = embeddedSub[1];
		}
		const trailingArabic = rest.match(/\s+(1)[.．、]\s*\S/u);
		return {
			kind: "decimal",
			decimalParts: decimal.split("."),
			normalizedLeaf,
			...(trailingArabic ? { trailingArabicOrdinal: 1 } : {}),
		};
	}

	// Merged chapter + subsection heading, e.g. "4 合资企业与二次供水管理 4.1 合资企业成立背景"
	const chapterWithSub = leaf.match(
		/^([1-9]\d?)\s+[^\n]{1,40}?\s+(\1\.[1-9]\d?(?:\.[1-9]\d?){0,2})(?=[\s、.．:：）)\p{Script=Han}A-Za-z])/u,
	);
	if (chapterWithSub?.[2]) {
		const rest = leaf.slice(
			(chapterWithSub.index ?? 0) + chapterWithSub[0].length,
		);
		const trailingArabic = rest.match(/\s+(1)[.．、]\s*\S/u);
		return {
			kind: "decimal",
			decimalParts: chapterWithSub[2].split("."),
			normalizedLeaf,
			...(trailingArabic ? { trailingArabicOrdinal: 1 } : {}),
		};
	}

	// Arabic numbered item heading, e.g. "1. 均认为...", "2. 均看好..."
	const arabicItem = leaf.match(/^([1-9]\d?)[.．、）)]\s*\S/u);
	if (arabicItem?.[1] && !/^[1-9]\d?\.\d/u.test(leaf)) {
		return {
			kind: "arabic_item",
			ordinal: Number.parseInt(arabicItem[1], 10),
			normalizedLeaf,
		};
	}

	// Chinese numeral list item, e.g. "一、听证参加人信息", "三、语言使用权利告知"
	const cnItem = leaf.match(/^([一二三四五六七八九十]{1,3})[、.．]\s*\S/u);
	if (cnItem?.[1]) {
		const ordinal = parseChineseOrdinal(cnItem[1]);
		if (ordinal !== null) {
			return { kind: "cn_item", ordinal, normalizedLeaf };
		}
	}

	const cnParenItem = leaf.match(
		/^[(（]([一二三四五六七八九十]{1,3})[)）]\s*\S/u,
	);
	if (cnParenItem?.[1]) {
		const ordinal = parseChineseOrdinal(cnParenItem[1]);
		if (ordinal !== null) {
			return { kind: "cn_paren_item", ordinal, normalizedLeaf };
		}
	}

	// Standalone top-level numbered chapter, e.g. "1 全球外汇市场趋势分析", "5券商对2024..."
	const standaloneChapter = leaf.match(
		/^([1-9]\d?)\s*([\p{Script=Han}A-Za-z].*)$/u,
	);
	if (
		standaloneChapter?.[1] &&
		standaloneChapter[2] &&
		!NON_CHAPTER_UNIT_FOLLOWERS.test(standaloneChapter[2])
	) {
		return {
			kind: "decimal",
			decimalParts: [standaloneChapter[1]],
			normalizedLeaf,
		};
	}

	return null;
}

export function areContiguousSiblingSections(
	anchor: SectionHeadingStructure,
	left: SectionHeadingStructure,
	right: SectionHeadingStructure,
): boolean {
	// Never merge repeated identical titles across distinct instances.
	if (left.normalizedLeaf === right.normalizedLeaf) return false;

	// Rule A: Decimal subsections within the same chapter (or same x.y branch for x.y.z anchors).
	if (left.kind === "decimal" && right.kind === "decimal") {
		if (left.decimalParts[0] !== right.decimalParts[0]) return false;
		if (anchor.kind === "decimal" && anchor.decimalParts.length >= 3) {
			const branch = `${anchor.decimalParts[0]}.${anchor.decimalParts[1]}`;
			const leftBranch =
				left.decimalParts.length >= 2
					? `${left.decimalParts[0]}.${left.decimalParts[1]}`
					: null;
			const rightBranch =
				right.decimalParts.length >= 2
					? `${right.decimalParts[0]}.${right.decimalParts[1]}`
					: null;
			return leftBranch === branch && rightBranch === branch;
		}
		return true;
	}

	// Rule B: Sequential sub-items (1. -> 2. -> 3., 一、 -> 二、 -> 三、).
	if (
		left.kind !== "decimal" &&
		right.kind === left.kind &&
		right.ordinal === left.ordinal + 1
	) {
		return true;
	}
	if (
		left.kind === "decimal" &&
		left.trailingArabicOrdinal !== undefined &&
		right.kind === "arabic_item" &&
		right.ordinal === left.trailingArabicOrdinal + 1
	) {
		return true;
	}

	// Rule C: Decimal section immediately introducing an ordinal-1 sub-item list.
	if (
		left.kind === "decimal" &&
		right.kind !== "decimal" &&
		right.ordinal === 1
	) {
		return true;
	}

	return false;
}

function formatSectionBlock(hit: QdrantSearchHit): string {
	const body = (hit.payload.body || hit.payload.text).trim();
	const heading = leafHeading(
		hit.payload.section_path,
		hit.payload.heading_text,
	);
	if (!heading || body.includes(heading)) return body;
	return `${heading}\n${body}`;
}

export const SHORT_MICRO_SECTION_MAX_CHARS = 1_400;
export const ADJACENT_SECTION_BACK_STEPS = 2;
export const ADJACENT_SECTION_FORWARD_STEPS = 4;

export function adjacentSectionInstanceOffsets(): readonly number[] {
	const offsets: number[] = [];
	for (let step = 1; step <= ADJACENT_SECTION_BACK_STEPS; step += 1) {
		offsets.push(-step);
	}
	for (let step = 1; step <= ADJACENT_SECTION_FORWARD_STEPS; step += 1) {
		offsets.push(step);
	}
	return offsets;
}

export function isShortStructuredSection(hit: QdrantSearchHit): boolean {
	if (hit.payload.record_type !== "section") return false;
	if (
		typeof hit.payload.section_instance !== "number" ||
		!Number.isInteger(hit.payload.section_instance) ||
		hit.payload.section_instance < 0
	) {
		return false;
	}
	const body = (hit.payload.body || hit.payload.text).trim();
	if (!body || body.length >= SHORT_MICRO_SECTION_MAX_CHARS) return false;
	return (
		parseSectionHeadingStructure(
			hit.payload.section_path,
			hit.payload.heading_text,
		) !== null
	);
}

export function coalesceAdjacentMicroSections(
	anchor: QdrantSearchHit,
	sameDocGenSections: readonly QdrantSearchHit[],
	budget: { maxTokens: number; maxChars: number },
): { text: string; sections: QdrantSearchHit[] } | null {
	if (!isShortStructuredSection(anchor)) return null;
	const anchorInstance = anchor.payload.section_instance;
	if (anchorInstance == null) return null;
	const anchorStruct = parseSectionHeadingStructure(
		anchor.payload.section_path,
		anchor.payload.heading_text,
	);
	if (!anchorStruct) return null;

	// Group by section_instance; skip multi-part sections (already large > 2400 chars).
	const byInstance = new Map<number, QdrantSearchHit[]>();
	for (const section of sameDocGenSections) {
		if (
			section.payload.record_type !== "section" ||
			section.payload.doc_id !== anchor.payload.doc_id ||
			section.payload.generation_id !== anchor.payload.generation_id ||
			typeof section.payload.section_instance !== "number"
		) {
			continue;
		}
		const list = byInstance.get(section.payload.section_instance) ?? [];
		list.push(section);
		byInstance.set(section.payload.section_instance, list);
	}
	const singleByInstance = new Map<
		number,
		{ hit: QdrantSearchHit; struct: SectionHeadingStructure }
	>();
	for (const [instance, list] of byInstance) {
		if (list.length !== 1) continue;
		const hit = list[0];
		if (!hit) continue;
		const struct = parseSectionHeadingStructure(
			hit.payload.section_path,
			hit.payload.heading_text,
		);
		if (struct) singleByInstance.set(instance, { hit, struct });
	}
	const anchorEntry = singleByInstance.get(anchorInstance);
	if (!anchorEntry) return null;

	let low = anchorInstance;
	let high = anchorInstance;
	let canGoBack = true;
	let canGoForward = true;
	const included = new Map<number, QdrantSearchHit>([[anchorInstance, anchor]]);

	const render = (entries: ReadonlyMap<number, QdrantSearchHit>) =>
		[...entries.entries()]
			.sort(([a], [b]) => a - b)
			.map(([, hit]) => formatSectionBlock(hit))
			.filter(Boolean)
			.join("\n\n")
			.trim();

	const tryInclude = (
		candidateInstance: number,
		direction: "back" | "forward",
	): boolean => {
		const candidate = singleByInstance.get(candidateInstance);
		if (!candidate) return false;
		const boundary = singleByInstance.get(direction === "back" ? low : high);
		if (!boundary) return false;
		const related =
			direction === "back"
				? areContiguousSiblingSections(
						anchorStruct,
						candidate.struct,
						boundary.struct,
					)
				: areContiguousSiblingSections(
						anchorStruct,
						boundary.struct,
						candidate.struct,
					);
		if (!related) return false;
		const next = new Map(included);
		next.set(candidateInstance, candidate.hit);
		const combined = render(next);
		if (
			combined.length > budget.maxChars ||
			estimateTokens(combined) > budget.maxTokens
		) {
			return false;
		}
		included.set(candidateInstance, candidate.hit);
		if (direction === "back") low = candidateInstance;
		else high = candidateInstance;
		return true;
	};

	const maxSteps = Math.max(
		ADJACENT_SECTION_BACK_STEPS,
		ADJACENT_SECTION_FORWARD_STEPS,
	);
	for (let step = 1; step <= maxSteps; step += 1) {
		if (canGoBack && step <= ADJACENT_SECTION_BACK_STEPS) {
			canGoBack = tryInclude(low - 1, "back");
		}
		if (canGoForward && step <= ADJACENT_SECTION_FORWARD_STEPS) {
			canGoForward = tryInclude(high + 1, "forward");
		}
		if (!canGoBack && !canGoForward) break;
	}

	if (included.size <= 1) return null;
	const ordered = [...included.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, hit]) => hit);
	return {
		text: render(included),
		sections: ordered,
	};
}
