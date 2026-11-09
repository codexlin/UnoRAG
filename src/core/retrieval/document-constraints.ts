import type { DocumentContext } from "../document-ir/document-context";

export type ActiveDocumentDescriptor = {
	documentId: string;
	generationId: string;
	filename: string;
	context: DocumentContext | null;
};

export type DocumentConstraint = {
	status: "none" | "resolved" | "unavailable" | "ambiguous";
	documents: ActiveDocumentDescriptor[];
	outlineLevel?: number | "children" | "all";
	parentHeading?: string;
};

const FILE = /[\p{L}\p{N}_.()（）-]+\.(?:pdf|docx|markdown|md|txt)\b/giu;
const CODE = /\b[A-Z][A-Z0-9]*(?:[-/][A-Z0-9]+){2,}\b/gi;
const OUTLINE =
	/(?:[一二三四五六1-6]级标题|子标题|(?:文档|文件|章节)目录|目录(?:结构|大纲)|所有标题|全部标题|\bheadings?\b|table of contents)/i;
const QUOTED_TITLE = /《([^》]{4,})》|“([^”]{4,})”|「([^」]{4,})」/gu;
const VERSIONED_TITLE_PREFIX =
	/^(?:[a-z][a-z0-9_-]{0,31}\s+)?v\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?\s+/u;

export function stripFilenameReferences(question: string): string {
	return question.replace(new RegExp(FILE), "");
}

export function needsDocumentConstraint(question: string): boolean {
	return (
		new RegExp(FILE).test(question) ||
		new RegExp(CODE).test(question) ||
		OUTLINE.test(question) ||
		new RegExp(QUOTED_TITLE).test(question) ||
		/[\p{L}\p{N}]{4,}(?:前|后|时)[，,：:\s]/u.test(question)
	);
}

function normalize(value: string): string {
	return value.normalize("NFKC").trim().toLowerCase();
}

export function resolveDocumentConstraint(
	question: string,
	catalog: ActiveDocumentDescriptor[],
	complete: boolean,
): DocumentConstraint {
	const none: DocumentConstraint = { status: "none", documents: [] };
	const unavailable: DocumentConstraint = {
		status: "unavailable",
		documents: [],
	};
	if (!complete) return unavailable;
	const filenames = [
		...new Set(
			[...question.matchAll(new RegExp(FILE))].map((m) => normalize(m[0])),
		),
	];
	const codes = [
		...new Set(
			[...question.matchAll(new RegExp(CODE))].map((m) => normalize(m[0])),
		),
	];
	const intentQuestion = stripFilenameReferences(question);
	const matches: ActiveDocumentDescriptor[] = [];
	const addUnique = (
		candidates: ActiveDocumentDescriptor[],
	): DocumentConstraint | null => {
		if (candidates.length !== 1)
			return candidates.length > 1
				? { status: "ambiguous", documents: [] }
				: unavailable;
		const candidate = candidates[0];
		if (
			candidate &&
			!matches.some((item) => item.documentId === candidate.documentId)
		)
			matches.push(candidate);
		return null;
	};
	for (const filename of filenames) {
		const failure = addUnique(
			catalog.filter((doc) => normalize(doc.filename) === filename),
		);
		if (failure) return failure;
	}
	for (const code of codes) {
		const candidates = catalog.filter((doc) =>
			doc.context?.identifiers.some((id) => normalize(id) === code),
		);
		if (!candidates.length) {
			// Unknown product codes remain ordinary content queries; explicit document
			// numbers and catalogs missing identity metadata cannot be guessed.
			if (
				/(?:文件|文档|制度|规程|合同)编号|文号|document\s*(?:id|no|number)/i.test(
					question,
				) ||
				catalog.some((doc) => !doc.context?.identifiers_complete)
			)
				return unavailable;
			continue;
		}
		// An observed identifier is a positive source constraint, not a claim that
		// every unrelated document was parsed in full. Unknown identities above
		// remain fail-closed when metadata is incomplete; known duplicates below
		// remain ambiguous.
		if (
			filenames.length &&
			candidates.some(
				(doc) => !matches.some((match) => match.documentId === doc.documentId),
			)
		)
			return unavailable;
		const failure = addUnique(candidates);
		if (failure) return failure;
	}
	if (!matches.length) {
		for (const [, explicit, curly, corner] of question.matchAll(QUOTED_TITLE)) {
			const title = normalize(explicit ?? curly ?? corner ?? "");
			if (!title) {
				if (explicit) return unavailable;
				continue;
			}
			let candidates = catalog.filter(
				(doc) => normalize(doc.context?.title ?? "") === title,
			);
			// Only strip an explicit version prefix; never fuzzy-match a named source.
			if (
				!candidates.length &&
				explicit &&
				Array.from(title).length >= 4 &&
				!OUTLINE.test(intentQuestion)
			) {
				candidates = catalog.filter(
					(doc) =>
						normalize(doc.context?.title ?? "").replace(
							VERSIONED_TITLE_PREFIX,
							"",
						) === title,
				);
			}
			if (candidates.length) {
				const failure = addUnique(candidates);
				if (failure) return failure;
			} else if (explicit) return unavailable;
		}
	}
	if (!matches.length) {
		// A qualified workflow subject (e.g. deployment-before vs restore-before)
		// must not be replaced by a merely similar procedure from another phase.
		const subject = question
			.replace(/^(?:请问|请说明|请描述)/u, "")
			.match(/([\p{L}\p{N}]{4,40})(?:前|后|时)[，,：:\s]/u)?.[1];
		if (subject) {
			const candidates = catalog.filter((doc) =>
				normalize(doc.context?.title ?? "").startsWith(normalize(subject)),
			);
			if (candidates.length) {
				const failure = addUnique(candidates);
				if (failure) return failure;
			}
		}
	}
	if (!matches.length) return OUTLINE.test(intentQuestion) ? unavailable : none;
	let outlineLevel: DocumentConstraint["outlineLevel"];
	if (OUTLINE.test(intentQuestion)) {
		const level = question.match(/([一二三四五六1-6])级标题/u)?.[1];
		outlineLevel = level
			? Number(level) || "一二三四五六".indexOf(level) + 1
			: /子标题/.test(question)
				? "children"
				: "all";
	}
	return {
		status: "resolved",
		documents: matches,
		...(outlineLevel ? { outlineLevel } : {}),
		...(outlineLevel === "children"
			? { parentHeading: question.match(/[“「]([^”」]+)[”」]/u)?.[1] }
			: {}),
	};
}

/** Only pure enumeration is eligible for exact structured execution. */
export function executeOutlineQuestion(
	question: string,
	constraint: DocumentConstraint,
): string | null {
	let enumeration = normalize(question);
	for (const doc of constraint.documents) {
		for (const literal of [
			doc.filename,
			doc.context?.title,
			constraint.parentHeading,
		]) {
			if (literal) enumeration = enumeration.replaceAll(normalize(literal), "");
		}
	}
	enumeration = normalize(enumeration).replace(
		/[\s，,。.;；:：？?！!“”「」《》"'()（）]/gu,
		"",
	);
	const chineseEnumeration =
		/^(?:请|帮我|列出|列举|展示|查看|显示|中|里|内|的|里面|下面|之下|下属|下|所有|全部|文档|文件|文章|章节|有哪些|哪些|包含|包括|一|二|三|四|五|六|[1-6]|级|标题|子标题|目录|结构|大纲|管理主题|主题|条目|名称|是|什么|有|都|分别|为)+$/u;
	const englishEnumeration =
		/^(?:what|are|is|the|list|show|all|headings?|in|of|under|document|file|tableofcontents)+$/i;
	const levels = [...question.matchAll(/([一二三四五六1-6]+)级标题/gu)];
	if (
		constraint.documents.length !== 1 ||
		!constraint.outlineLevel ||
		!/(?:哪些|有哪些|列出|列举|包含|目录|what|list)/i.test(question) ||
		(!chineseEnumeration.test(enumeration) &&
			!englishEnumeration.test(enumeration)) ||
		levels.length > 1 ||
		levels.some((match) => match[1]?.length !== 1)
	)
		return null;
	const context = constraint.documents[0]?.context;
	if (!context?.outline_complete) return null;
	let entries = context.outline;
	if (constraint.outlineLevel === "children") {
		const parents = entries.filter(
			(entry) => entry.text === constraint.parentHeading,
		);
		const parent = parents.length === 1 ? parents[0] : undefined;
		if (!parent) return null;
		const start = entries.indexOf(parent) + 1;
		const end = entries.findIndex(
			(entry, index) => index >= start && entry.level <= parent.level,
		);
		entries = entries
			.slice(start, end < 0 ? undefined : end)
			.filter((entry) => entry.level === parent.level + 1);
	} else if (typeof constraint.outlineLevel === "number") {
		entries = entries.filter(
			(entry) => entry.level === constraint.outlineLevel,
		);
	}
	if (!entries.length) return null;
	return `解析目录中的标题如下：\n${entries.map((entry) => `- ${entry.text}`).join("\n")}\n[1]`;
}
