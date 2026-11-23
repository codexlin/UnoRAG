import { createHash } from "node:crypto";

import {
	type Chunk,
	ChunkSchema,
	type DocumentIR,
	type DocumentNode,
	type SplitStrategy,
} from "../document-ir";
import {
	estimateTokens,
	sliceByTokenBudget,
	sliceTailByTokenBudget,
} from "../text/token-estimate";
import {
	type ContextualRetrievalOptions,
	contextualizeChunks,
} from "./contextual-retrieval";

export const CHUNK_POLICY_VERSION = "v2";

const DEFAULT_MAX_TOKENS = 400;
const DEFAULT_MAX_CHARS = 1_800;

const PROFILE_TARGET_RATIOS = {
	precise: 0.65,
	balanced: 1,
	narrative: 1,
	table_heavy: 1,
} as const;

const RECURSIVE_SEPARATORS = [
	"\n\n",
	"\n",
	"。",
	"；",
	"！",
	"？",
	". ",
	"; ",
	"! ",
	"? ",
	" ",
] as const;

export type ChunkProfileName = keyof typeof PROFILE_TARGET_RATIOS;

export type ChunkingProfile = {
	name: ChunkProfileName;
	targetTokens: number;
	maxTokens: number;
	overlapTokens: number;
	targetChars: number;
	maxChars: number;
	overlapChars: number;
	headingBoundaryLevel: number;
	semanticEnabled: boolean;
	semanticMinChars?: number;
	semanticBreakPercentile: number;
	semanticMinChunkChars: number;
	tableRowsPerRecord: number;
	tableTokensPerRecord: number;
	policyVersion: string;
};

export type ChunkingOptions = {
	contextualRetrieval?: ContextualRetrievalOptions;
	profileName?: ChunkProfileName;
	chunkSize?: number;
	chunkOverlap?: number;
	headingBoundaryLevel?: number;
	semanticEnabled?: boolean;
	semanticMinChars?: number;
	semanticBreakPercentile?: number;
	policyVersion?: string;
	semanticEmbedder?: (texts: string[]) => Promise<number[][]>;
};

type ChunkDecision = {
	strategy: SplitStrategy;
	reason: string;
};

type Section = {
	sectionPath: string | null;
	headingText: string | null;
	bodyText: string;
	nodeIds: string[];
	specialNodes: DocumentNode[];
	pageStart: number | null;
	pageEnd: number | null;
	forcePageStrategy: boolean;
};

export function buildChunkingProfile(
	options: ChunkingOptions = {},
): ChunkingProfile {
	const name = options.profileName ?? "balanced";
	const ratio = PROFILE_TARGET_RATIOS[name];
	if (ratio === undefined) throw new Error(`unknown chunking profile: ${name}`);
	const charSized = options.chunkSize !== undefined;
	const maxChars = Math.max(
		100,
		Math.trunc(options.chunkSize ?? DEFAULT_MAX_CHARS),
	);
	const targetChars = charSized
		? Math.max(100, Math.round(maxChars * ratio))
		: maxChars;
	const maxTokens = charSized ? Number.POSITIVE_INFINITY : DEFAULT_MAX_TOKENS;
	const targetTokens = Math.round(maxTokens * ratio);
	const charOverlap = options.chunkOverlap ?? (charSized ? 80 : undefined);
	const overlapChars =
		charOverlap === undefined
			? Number.POSITIVE_INFINITY
			: Math.max(0, Math.min(Math.trunc(charOverlap), targetChars - 1));
	const overlapTokens =
		charOverlap === undefined ? 60 : Number.POSITIVE_INFINITY;
	const semanticMinChars =
		options.semanticMinChars !== undefined || charSized
			? Math.max(
					charSized ? maxChars : 0,
					Math.trunc(options.semanticMinChars ?? 1_200),
				)
			: undefined;
	return {
		name,
		targetTokens,
		maxTokens,
		overlapTokens,
		targetChars,
		maxChars,
		overlapChars,
		headingBoundaryLevel: Math.max(
			1,
			Math.trunc(options.headingBoundaryLevel ?? 2),
		),
		semanticEnabled: options.semanticEnabled ?? false,
		semanticMinChars,
		semanticBreakPercentile: Math.max(
			1,
			Math.min(99, Math.trunc(options.semanticBreakPercentile ?? 85)),
		),
		semanticMinChunkChars: Math.max(
			80,
			Math.min(Math.trunc(targetChars / 2), 240),
		),
		tableRowsPerRecord: name === "table_heavy" ? 20 : 40,
		tableTokensPerRecord: name === "table_heavy" ? 1_000 : 1_400,
		policyVersion: options.policyVersion?.trim() || CHUNK_POLICY_VERSION,
	};
}

export function recommendChunkProfile(input: DocumentIR): ChunkProfileName {
	let tableVolume = 0;
	let totalVolume = 0;
	for (const node of input.nodes) {
		const volume = nonWhitespaceLength(node.text);
		if (node.type !== "table") {
			totalVolume += volume;
			continue;
		}
		const tableChars = volume || tableCellVolume(node);
		tableVolume += tableChars;
		totalVolume += tableChars;
	}
	return tableVolume * 5 > totalVolume * 2 ? "table_heavy" : "balanced";
}

function tableCellVolume(node: DocumentNode): number {
	const { headers, rows } = tableParts(node);
	let volume = headers.reduce(
		(sum, cell) => sum + nonWhitespaceLength(cell),
		0,
	);
	for (const row of rows) {
		for (const cell of row) volume += nonWhitespaceLength(cell);
	}
	return volume;
}

function nonWhitespaceLength(text: string): number {
	let count = 0;
	for (const character of text) {
		if (!/\s/u.test(character)) count += 1;
	}
	return count;
}

export async function chunkDocument(
	input: DocumentIR,
	options: ChunkingOptions = {},
): Promise<Chunk[]> {
	if (input.nodes.length === 0) return [];
	const profileName = options.profileName ?? recommendChunkProfile(input);
	const profile = buildChunkingProfile({ ...options, profileName });
	const profileMetadata =
		options.profileName === undefined && profileName === "table_heavy"
			? { profile_auto_selected: true }
			: {};
	const sections = splitIntoSections(input.nodes, profile.headingBoundaryLevel);
	const chunks: Chunk[] = [];

	for (const section of sections) {
		for (const node of section.specialNodes) {
			let body =
				node.text.trim() ||
				tableJsonToText(node.table_json) ||
				(node.type === "figure" && node.meta?.has_figure_asset === true
					? `图表${node.page_start ? `（第${node.page_start}页）` : ""}`
					: "");
			if (!body) continue;
			const decision = specialNodeDecision(node.type);
			const pageStart = node.page_start ?? section.pageStart;
			const pageEnd = node.page_end ?? section.pageEnd;
			const meta: Record<string, unknown> = {
				...decisionMetadata(decision, profile),
				...profileMetadata,
			};
			if (node.type === "table" && (node.table_ir || node.table_json)) {
				const table = tableParts(node);
				meta.headers = table.headers;
				meta.rows = table.rows;
				meta.table_rows_per_record = profile.tableRowsPerRecord;
				meta.table_tokens_per_record = profile.tableTokensPerRecord;
				if (node.table_ir) {
					meta.table_ir = node.table_ir;
					meta.table_quality = node.table_ir.quality_report;
					meta.table_caption = node.table_ir.caption;
					meta.summary_rows = node.table_ir.summary_rows;
					meta.footnotes = node.table_ir.footnotes;
					const summaries = node.table_ir.summary_rows
						.map((row) => row.raw_text.trim())
						.filter(Boolean)
						.slice(0, 5);
					if (summaries.length > 0) {
						const suffix = `汇总说明：${summaries.join("；")}`;
						if (!body.includes(suffix)) body = `${body.trim()}\n\n${suffix}`;
					}
				}
			}
			chunks.push(
				makeChunk({
					index: chunks.length,
					body,
					preamble: buildPreamble({
						title: input.title,
						sectionPath: section.sectionPath,
						headingText: section.headingText,
						pageStart,
						pageEnd,
					}),
					document: input,
					sectionPath: section.sectionPath,
					headingText: section.headingText,
					pageStart,
					pageEnd,
					nodeIds: [node.id],
					tableId: node.table_id,
					figureId: node.figure_id,
					decision,
					meta,
				}),
			);
		}

		const body = section.bodyText.trim();
		if (!body) continue;
		let decision = textDecision({
			text: body,
			sourceFormat: input.source_format,
			sectionPath: section.sectionPath,
			forcePageStrategy: section.forcePageStrategy,
			profile,
			semanticAvailable: Boolean(options.semanticEmbedder),
		});
		let pieces: string[];
		let extraMeta: Record<string, unknown> = {};
		if (decision.strategy === "semantic" && options.semanticEmbedder) {
			try {
				const semantic = await semanticSplit(
					body,
					profile,
					options.semanticEmbedder,
				);
				pieces = semantic.pieces;
				extraMeta = {
					semantic_distance_threshold: semantic.distanceThreshold,
					semantic_unit_count: semantic.unitCount,
				};
			} catch (error) {
				decision = {
					strategy: "recursive",
					reason: "semantic_error_fallback",
				};
				extraMeta = {
					semantic_fallback:
						error instanceof Error ? error.name : "UnknownError",
				};
				pieces = recursiveSplit(body, profile);
			}
		} else if (decision.strategy === "page") {
			pieces = [body];
		} else if (fitsBudget(body, profile.targetChars, profile.targetTokens)) {
			pieces = [body];
		} else {
			pieces = recursiveSplit(body, profile);
		}
		if (pieces.length === 0) {
			pieces = budgetWindow(body, profile);
			decision = {
				strategy: "char_window",
				reason: "recursive_empty_fallback",
			};
		}
		const preamble = buildPreamble({
			title: input.title,
			sectionPath: section.sectionPath,
			headingText: section.headingText,
			pageStart: section.pageStart,
			pageEnd: section.pageEnd,
		});
		for (const piece of pieces) {
			chunks.push(
				makeChunk({
					index: chunks.length,
					body: piece,
					preamble,
					document: input,
					sectionPath: section.sectionPath,
					headingText: section.headingText,
					pageStart: section.pageStart,
					pageEnd: section.pageEnd,
					nodeIds: section.nodeIds,
					tableId: null,
					figureId: null,
					decision,
					meta: {
						...decisionMetadata(decision, profile),
						...profileMetadata,
						...extraMeta,
					},
				}),
			);
		}
	}

	const strategies: Record<string, number> = {};
	let fallbackCount = 0;
	for (const chunk of chunks) {
		strategies[chunk.split_strategy] =
			(strategies[chunk.split_strategy] ?? 0) + 1;
		if (String(chunk.meta.split_reason ?? "").includes("fallback")) {
			fallbackCount += 1;
		}
	}
	input.parser_report.metrics.chunking = {
		policy_version: profile.policyVersion,
		profile: profile.name,
		...profileMetadata,
		chunk_count: chunks.length,
		strategies,
		fallback_count: fallbackCount,
	};
	await contextualizeChunks(input, chunks, options.contextualRetrieval);
	return chunks;
}

function splitIntoSections(
	nodes: DocumentNode[],
	boundaryLevel: number,
): Section[] {
	const sections: Section[] = [];
	let currentPath: string | null = null;
	let currentHeading: string | null = null;
	let bodyParts: string[] = [];
	let nodeIds: string[] = [];
	let specialNodes: DocumentNode[] = [];
	let pageStart: number | null = null;
	let pageEnd: number | null = null;
	let forcePageStrategy = false;

	const flush = () => {
		if (bodyParts.length === 0 && specialNodes.length === 0) return;
		sections.push({
			sectionPath: currentPath,
			headingText: currentHeading,
			bodyText: bodyParts.join("\n\n"),
			nodeIds: [...nodeIds],
			specialNodes: [...specialNodes],
			pageStart,
			pageEnd,
			forcePageStrategy,
		});
		bodyParts = [];
		nodeIds = [];
		specialNodes = [];
		pageStart = null;
		pageEnd = null;
		forcePageStrategy = false;
	};

	for (const node of nodes) {
		if (node.type === "heading" && node.level !== null) {
			flush();
			currentPath = node.path;
			currentHeading = node.text;
			nodeIds.push(node.id);
			pageStart = node.page_start;
			pageEnd = node.page_end ?? node.page_start;
			if (node.level > boundaryLevel && node.text) bodyParts.push(node.text);
			continue;
		}
		if (
			node.type === "table" ||
			node.type === "code" ||
			node.type === "figure"
		) {
			specialNodes.push(node);
			nodeIds.push(node.id);
			[pageStart, pageEnd] = extendPages(pageStart, pageEnd, node);
			continue;
		}
		if (node.type === "page") {
			flush();
			currentPath = node.path;
			currentHeading = node.path;
			forcePageStrategy = true;
			pageStart = node.page_start;
			pageEnd = node.page_end ?? node.page_start;
			if (node.text.trim()) bodyParts.push(node.text.trim());
			nodeIds.push(node.id);
			continue;
		}
		if (node.text.trim()) {
			bodyParts.push(node.text.trim());
			nodeIds.push(node.id);
			[pageStart, pageEnd] = extendPages(pageStart, pageEnd, node);
		}
	}
	flush();
	return sections;
}

function extendPages(
	start: number | null,
	end: number | null,
	node: DocumentNode,
): [number | null, number | null] {
	const nodeStart = node.page_start;
	const nodeEnd = node.page_end ?? node.page_start;
	if (nodeStart === null) return [start, end];
	return [
		start === null ? nodeStart : Math.min(start, nodeStart),
		end === null ? (nodeEnd ?? nodeStart) : Math.max(end, nodeEnd ?? nodeStart),
	];
}

function specialNodeDecision(type: DocumentNode["type"]): ChunkDecision {
	if (type === "table") {
		return { strategy: "table", reason: "structured_table" };
	}
	if (type === "code") {
		return { strategy: "code", reason: "structured_code" };
	}
	if (type === "figure") {
		return { strategy: "figure", reason: "structured_figure" };
	}
	throw new Error(`unsupported special node type: ${type}`);
}

function textDecision(input: {
	text: string;
	sourceFormat: string;
	sectionPath: string | null;
	forcePageStrategy: boolean;
	profile: ChunkingProfile;
	semanticAvailable: boolean;
}): ChunkDecision {
	const { text, profile } = input;
	const withinTarget = fitsBudget(
		text,
		profile.targetChars,
		profile.targetTokens,
	);
	if (input.forcePageStrategy) {
		return fitsBudget(text, profile.maxChars, profile.maxTokens)
			? { strategy: "page", reason: "page_boundary" }
			: { strategy: "recursive", reason: "page_over_max" };
	}
	if (input.sectionPath) {
		return withinTarget
			? { strategy: "heading", reason: "structured_heading" }
			: {
					strategy: "recursive",
					reason: "heading_section_over_target",
				};
	}
	if (withinTarget) {
		return { strategy: "recursive", reason: "short_unstructured_text" };
	}
	if (
		profile.semanticEnabled &&
		(profile.semanticMinChars === undefined
			? estimateTokens(text) >= profile.maxTokens * 2
			: text.length >= profile.semanticMinChars)
	) {
		if (!looksLikeNarrative(input.text, input.sourceFormat)) {
			return { strategy: "recursive", reason: "semantic_ineligible_content" };
		}
		if (!input.semanticAvailable) {
			return {
				strategy: "recursive",
				reason: "semantic_unavailable_fallback",
			};
		}
		return { strategy: "semantic", reason: "unstructured_long_narrative" };
	}
	return { strategy: "recursive", reason: "unstructured_text" };
}

function decisionMetadata(
	decision: ChunkDecision,
	profile: ChunkingProfile,
): Record<string, unknown> {
	return {
		chunk_policy_version: profile.policyVersion,
		chunk_profile: profile.name,
		split_reason: decision.reason,
		target_chars: profile.targetChars,
		max_chars: profile.maxChars,
		...(Number.isFinite(profile.maxTokens)
			? { target_tokens: profile.targetTokens, max_tokens: profile.maxTokens }
			: {}),
		...(Number.isFinite(profile.overlapTokens)
			? { overlap_tokens: profile.overlapTokens }
			: {}),
		table_rows_per_record: profile.tableRowsPerRecord,
		table_tokens_per_record: profile.tableTokensPerRecord,
	};
}

function makeChunk(input: {
	index: number;
	body: string;
	preamble: string;
	document: DocumentIR;
	sectionPath: string | null;
	headingText: string | null;
	pageStart: number | null;
	pageEnd: number | null;
	nodeIds: string[];
	tableId: string | null;
	figureId: string | null;
	decision: ChunkDecision;
	meta: Record<string, unknown>;
}): Chunk {
	const body = input.body.trim();
	const preamble = input.preamble.trim();
	return ChunkSchema.parse({
		chunk_index: input.index,
		text: preamble && body ? `${preamble}\n\n${body}` : body || preamble,
		body,
		preamble,
		section_path: input.sectionPath,
		heading_text: input.headingText,
		page_start: input.pageStart,
		page_end: input.pageEnd,
		page_label: formatPageLabel(input.pageStart, input.pageEnd),
		node_ids: [...input.nodeIds],
		table_id: input.tableId,
		figure_id: input.figureId,
		split_strategy: input.decision.strategy,
		source_format: input.document.source_format,
		content_hash: contentFingerprint(input.document),
		meta: input.meta,
	});
}

function tableParts(node: DocumentNode): {
	headers: string[];
	rows: string[][];
} {
	if (node.table_ir) {
		return {
			headers: node.table_ir.columns.map((column) => column.name),
			rows: node.table_ir.rows.map((row) =>
				row.cells.map((cell) => cell.raw_text),
			),
		};
	}
	if (
		node.table_json &&
		!Array.isArray(node.table_json) &&
		typeof node.table_json === "object"
	) {
		const headers = Array.isArray(node.table_json.headers)
			? node.table_json.headers.map(String)
			: [];
		const rows = Array.isArray(node.table_json.rows)
			? node.table_json.rows.map((row) =>
					Array.isArray(row) ? row.map(String) : [String(row)],
				)
			: [];
		return { headers, rows };
	}
	return {
		headers: [],
		rows: Array.isArray(node.table_json)
			? node.table_json.map((row) =>
					Array.isArray(row) ? row.map(String) : [String(row)],
				)
			: [],
	};
}

function tableJsonToText(value: DocumentNode["table_json"]): string {
	if (!value) return "";
	if (Array.isArray(value)) {
		return value
			.map((row) => (Array.isArray(row) ? row.map(String).join(" | ") : ""))
			.filter(Boolean)
			.join("\n");
	}
	const headers = Array.isArray(value.headers) ? value.headers.map(String) : [];
	const rows = Array.isArray(value.rows)
		? value.rows.map((row) =>
				Array.isArray(row) ? row.map(String).join(" | ") : String(row),
			)
		: [];
	return [headers.join(" | "), ...rows].filter(Boolean).join("\n");
}

function fitsBudget(
	text: string,
	maxChars: number,
	maxTokens: number,
): boolean {
	return (
		text.length <= maxChars &&
		(!Number.isFinite(maxTokens) || estimateTokens(text) <= maxTokens)
	);
}

function recursiveSplit(text: string, profile: ChunkingProfile): string[] {
	const cleaned = text.trim();
	if (!cleaned) return [];
	const { targetChars, targetTokens } = profile;
	const fits = (piece: string) => fitsBudget(piece, targetChars, targetTokens);
	const parts = splitBySeparators(cleaned, RECURSIVE_SEPARATORS, fits);
	const merged: string[] = [];
	let buffer = "";
	for (const part of parts) {
		const candidate = `${buffer}${part}`;
		if (fits(candidate)) {
			buffer = candidate;
			continue;
		}
		if (buffer.trim()) merged.push(buffer.trim());
		if (fits(part)) {
			const overlap = sliceTailByTokenBudget(
				buffer,
				Math.min(profile.overlapTokens, targetTokens - estimateTokens(part)),
				Math.min(profile.overlapChars, targetChars - part.length),
			);
			buffer = overlap + part;
		} else {
			for (const piece of budgetWindow(part, profile)) merged.push(piece);
			buffer = "";
		}
	}
	if (buffer.trim()) merged.push(buffer.trim());
	return merged;
}

function splitBySeparators(
	text: string,
	separators: readonly string[],
	fits: (text: string) => boolean,
): string[] {
	const [separator, ...rest] = separators;
	if (!separator || fits(text)) return [text];
	const parts = text.split(separator);
	return parts.flatMap((part, index) =>
		splitBySeparators(
			index < parts.length - 1 ? part + separator : part,
			rest,
			fits,
		),
	);
}

function budgetWindow(text: string, profile: ChunkingProfile): string[] {
	const pieces: string[] = [];
	let start = 0;
	while (start < text.length) {
		const piece = sliceByTokenBudget(
			text.slice(start),
			profile.targetTokens,
			profile.targetChars,
		);
		if (!piece) break;
		if (piece.trim()) pieces.push(piece.trim());
		if (start + piece.length === text.length) break;
		const firstWidth = (piece.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
		const tail = sliceTailByTokenBudget(
			piece,
			profile.overlapTokens,
			Math.min(profile.overlapChars, piece.length - firstWidth),
		);
		start += piece.length - tail.length;
	}
	return pieces;
}

function looksLikeNarrative(text: string, sourceFormat: string): boolean {
	if (
		!["txt", "pdf", "docx", "md", "markdown"].includes(
			sourceFormat.toLowerCase(),
		)
	) {
		return false;
	}
	const cleaned = text.trim();
	if (!cleaned) return false;
	const lines = cleaned
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (
		lines.length > 0 &&
		lines.filter((line) => line.includes("|") || line.includes("\t")).length /
			lines.length >=
			0.4
	) {
		return false;
	}
	const codeMarks =
		cleaned.match(/[{};]|(?:def|class|function)\s+\w+/g)?.length ?? 0;
	if (codeMarks >= Math.max(6, Math.trunc(cleaned.length / 120))) return false;
	const paragraphs = cleaned
		.split(/\n\s*\n/)
		.filter((part) => part.trim()).length;
	const sentences = cleaned.match(/[。！？!?；;](?:\s|$)|\.\s/g)?.length ?? 0;
	return paragraphs >= 3 || sentences >= 4;
}

async function semanticSplit(
	text: string,
	profile: ChunkingProfile,
	embedder: (texts: string[]) => Promise<number[][]>,
): Promise<{
	pieces: string[];
	distanceThreshold: number;
	unitCount: number;
}> {
	const units = semanticUnits(text);
	if (units.length < 2) throw semanticError("not enough semantic units");
	if (
		units.some((unit) => !fitsBudget(unit, profile.maxChars, profile.maxTokens))
	) {
		throw semanticError("semantic unit exceeds chunk budget");
	}
	const vectors = await embedder(units);
	if (
		vectors.length !== units.length ||
		vectors.length === 0 ||
		vectors.some((vector) => vector.length === 0)
	) {
		throw semanticError("embedding count or vector mismatch");
	}
	const distances = vectors.slice(0, -1).map((vector, index) => {
		const next = vectors[index + 1];
		if (!next) throw semanticError("embedding pair is missing");
		return 1 - cosineSimilarity(vector, next);
	});
	const threshold = percentile(distances, profile.semanticBreakPercentile);
	const boundaries = new Set(
		distances.flatMap((distance, index) =>
			distance >= threshold && distance > 0 ? [index] : [],
		),
	);
	const pieces: string[] = [];
	let buffer: string[] = [];
	const flush = () => {
		const body = buffer.join(" ").trim();
		if (body) pieces.push(body);
		buffer = [];
	};
	for (const [index, unit] of units.entries()) {
		const candidate = [...buffer, unit].join(" ").trim();
		if (
			buffer.length > 0 &&
			!fitsBudget(candidate, profile.maxChars, profile.maxTokens)
		)
			flush();
		buffer.push(unit);
		if (boundaries.has(index)) {
			const body = buffer.join(" ");
			const minimumReached = Number.isFinite(profile.targetTokens)
				? estimateTokens(body) >= Math.floor(profile.targetTokens / 2)
				: body.length >= profile.semanticMinChunkChars;
			if (minimumReached) flush();
		}
	}
	flush();
	if (pieces.length === 0)
		throw semanticError("semantic packing produced no chunks");
	return {
		pieces,
		distanceThreshold: Math.round(threshold * 1_000_000) / 1_000_000,
		unitCount: units.length,
	};
}

function semanticUnits(text: string): string[] {
	const units: string[] = [];
	for (const paragraph of text.trim().split(/\n\s*\n/)) {
		const cleaned = paragraph.trim();
		if (!cleaned) continue;
		const matches = cleaned.match(/[\s\S]+?(?:[。！？!?；;]+|\.\s+|$)/g) ?? [];
		units.push(...matches.map((item) => item.trim()).filter(Boolean));
	}
	return units;
}

function cosineSimilarity(left: number[], right: number[]): number {
	if (left.length !== right.length)
		throw semanticError("embedding dimension mismatch");
	if (
		left.some((value) => !Number.isFinite(value)) ||
		right.some((value) => !Number.isFinite(value))
	) {
		throw semanticError("embedding vector contains non-finite value");
	}
	const dot = left.reduce(
		(total, value, index) => total + value * (right[index] ?? 0),
		0,
	);
	const leftNorm = Math.sqrt(
		left.reduce((total, value) => total + value ** 2, 0),
	);
	const rightNorm = Math.sqrt(
		right.reduce((total, value) => total + value ** 2, 0),
	);
	if (leftNorm <= 0 || rightNorm <= 0) {
		throw semanticError("embedding vector has zero norm");
	}
	return Math.max(-1, Math.min(1, dot / (leftNorm * rightNorm)));
}

function percentile(values: number[], target: number): number {
	if (values.length === 0) throw semanticError("no semantic distances");
	const ordered = [...values].sort((left, right) => left - right);
	const rank = Math.max(
		0,
		Math.min(
			ordered.length - 1,
			Math.ceil((target / 100) * ordered.length) - 1,
		),
	);
	const value = ordered[rank];
	if (value === undefined)
		throw semanticError("semantic percentile is missing");
	return value;
}

function semanticError(message: string): Error {
	const error = new Error(message);
	error.name = "SemanticChunkError";
	return error;
}

export function formatPageLabel(
	start: number | null,
	end: number | null = null,
): string | null {
	if (start === null) return null;
	return end === null || end === start ? `p.${start}` : `p.${start}-${end}`;
}

export function buildPreamble(input: {
	title: string;
	sectionPath?: string | null;
	headingText?: string | null;
	pageStart?: number | null;
	pageEnd?: number | null;
}): string {
	const parts = [`文档《${input.title.trim() || "未命名文档"}》`];
	if (input.sectionPath) parts.push(input.sectionPath);
	else if (input.headingText) parts.push(input.headingText);
	if (input.pageStart !== null && input.pageStart !== undefined) {
		parts.push(
			input.pageEnd === null ||
				input.pageEnd === undefined ||
				input.pageEnd === input.pageStart
				? `第${input.pageStart}页`
				: `第${input.pageStart}-${input.pageEnd}页`,
		);
	}
	return parts.join(" · ");
}

function contentFingerprint(document: DocumentIR): string {
	if (document.content_hash) return document.content_hash;
	const content = document.nodes
		.map((node) => `${node.type}:${node.text}`)
		.join("\n");
	return createHash("sha256").update(content).digest("hex").slice(0, 32);
}
