import type { Chunk, DocumentIR } from "../document-ir";

export type ContextualizerInput = Readonly<{
	body: string;
	documentTitle: string;
	filename: string;
	headingText: string | null;
	pageStart: number | null;
	pageEnd: number | null;
	signal: AbortSignal;
}>;

export interface Contextualizer {
	contextualize(input: ContextualizerInput): Promise<string | null>;
}

export type ContextualRetrievalOptions = {
	enabled?: boolean;
	maxChunks?: number;
	timeoutMs?: number;
	contextualizer?: Contextualizer;
};

export function contextualRetrievalFromEnvironment(
	environment: Readonly<Record<string, string | undefined>>,
): ContextualRetrievalOptions {
	return {
		enabled: environment.CONTEXTUAL_RETRIEVAL_ENABLED?.trim() === "true",
		maxChunks: boundedInteger(
			Number(environment.CONTEXTUAL_RETRIEVAL_MAX_CHUNKS?.trim() || 40),
			40,
			0,
			40,
		),
		timeoutMs: boundedInteger(
			Number(environment.CONTEXTUAL_RETRIEVAL_TIMEOUT_MS?.trim() || 1000),
			1000,
			1,
			5000,
		),
	};
}

const deterministicContextualizer: Contextualizer = {
	async contextualize(input) {
		return [
			input.documentTitle || input.filename,
			input.filename !== input.documentTitle ? input.filename : "",
			input.headingText,
			input.pageStart === null
				? ""
				: `p. ${input.pageStart}${input.pageEnd !== null && input.pageEnd !== input.pageStart ? `–${input.pageEnd}` : ""}`,
		]
			.filter(Boolean)
			.join(" / ");
	},
};

export async function contextualizeChunks(
	document: DocumentIR,
	chunks: Chunk[],
	options?: ContextualRetrievalOptions,
): Promise<void> {
	if (options?.enabled !== true) return;
	const maxChunks = boundedInteger(options.maxChunks, 40, 0, 40);
	const timeoutMs = boundedInteger(options.timeoutMs, 1000, 1, 5000);
	const contextualizer = options.contextualizer ?? deterministicContextualizer;
	const narrativeNodes = new Set(
		document.nodes
			.filter((node) => ["paragraph", "page", "slide"].includes(node.type))
			.map((node) => node.id),
	);
	const degraded = ["ocr", "degraded"].includes(
		document.parser_report.mode.trim().toLowerCase(),
	);
	let attempted = 0;
	for (const chunk of chunks) {
		if (attempted >= maxChunks) break;
		const ocr =
			degraded ||
			(chunk.page_start !== null &&
				document.parser_report.ocr_pages.some(
					(page) =>
						page >= (chunk.page_start ?? 0) &&
						page <= (chunk.page_end ?? chunk.page_start ?? 0),
				));
		if (
			chunk.table_id ||
			chunk.figure_id ||
			["table", "figure", "code"].includes(chunk.split_strategy) ||
			!chunk.node_ids.some((id) => narrativeNodes.has(id)) ||
			chunk.body.trim().length < 160 ||
			(chunk.section_path?.trim() && !ocr)
		)
			continue;
		attempted += 1;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const prefix = await Promise.race([
				Promise.resolve().then(() =>
					contextualizer.contextualize({
						body: chunk.body,
						documentTitle: document.title,
						filename: document.filename,
						headingText: chunk.heading_text,
						pageStart: chunk.page_start,
						pageEnd: chunk.page_end,
						signal: controller.signal,
					}),
				),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => {
						reject(new Error("contextualizer timeout"));
						controller.abort();
					}, timeoutMs);
				}),
			]);
			if (typeof prefix === "string") {
				const bounded = prefix
					.replace(/\s+/g, " ")
					.trim()
					.slice(0, 240)
					.replace(/[\uD800-\uDBFF]$/u, "");
				if (bounded) chunk.meta.contextual_prefix = bounded;
			}
		} catch {
			// One provider failure disables further attempts for this document.
			break;
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
}

function boundedInteger(
	value: number | undefined,
	fallback: number,
	min: number,
	max: number,
): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(max, Math.max(min, Math.trunc(value)))
		: fallback;
}
