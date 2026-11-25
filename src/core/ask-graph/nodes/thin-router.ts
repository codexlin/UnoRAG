import {
	AiConcurrencyOverloadedError,
	AiConcurrencyWaitTimeoutError,
} from "../../ai/concurrency-gate";
import type { AskHistoryMessage } from "../state";
import {
	isDerivedCalculationQuestion,
	isFormFieldLookup,
	isFormTableOperation,
	isProseChecklistLookup,
} from "../table/query-intent";
import { hasFollowupReference } from "./rewrite";

export type RouteLayer = "thin_rule" | "gray_zone_model" | "gray_zone_fallback";

export interface ThinRouteDecision {
	queryType:
		| "fact"
		| "follow_up"
		| "summary"
		| "compare"
		| "table"
		| "section_lookup"
		| "ambiguous";
	reason: string;
	layer: RouteLayer;
	/** True only for non-trivial short/unclear inputs eligible for optional System-1 escalation. */
	grayZone: boolean;
}

export interface DecisionRouterResult {
	queryType: string;
	reason: string;
	/** Optional calibrated probability in [0, 1] (for System-1 classifiers like Jev Choice). */
	confidence?: number;
	provider?: string;
}

export interface DecisionRouterPort {
	classify(input: {
		question: string;
		history: AskHistoryMessage[];
		libraryId: string | null;
		signal?: AbortSignal;
	}): Promise<DecisionRouterResult>;
}

const VALID_ROUTER_QUERY_TYPES = new Set<ThinRouteDecision["queryType"]>([
	"fact",
	"follow_up",
	"summary",
	"compare",
	"table",
	"section_lookup",
	"ambiguous",
]);

export const EXPLICIT_TABLE_STRUCTURE_PATTERN =
	/(?:表格|表中|表内|明细表|清单|台账|逐行|多少行|表头|列名|字段|序号\s*(?:为|是)?\s*\d+|\b(?:rows?|row\s*#?\s*\d+|columns?|table\s+headers?|spreadsheet)\b)/iu;

export const FIGURE_PROSE_PATTERN =
	/(?:图\s*\d+|图表|折线图|柱状图|堆叠图|饼图|趋势图|雷达图|散点图|示意图|流程图|架构图|走势图|分布图|对比图|图示|附图|\b(?:fig\.?\s*\d+|figure\s*\d+|chart|diagram|graph|plot)\b)/iu;

const SUMMARY_PROSE_PATTERN = /(?:文末)?汇总说明(?:中|里|声称|称|显示|指出)?/u;
const IGNORE_SUMMARY_PROSE_PATTERN =
	/(?:忽略|不看|排除|不要参考)[^，。；;]{0,16}(?:文末)?汇总说明/u;

export const PROSE_SUPERLATIVE_COMPARE_PATTERN =
	/(?:最高|最低|最大|最小|最多|最少)[^，。？?]{0,16}(?:哪一|哪个|何种|什么)|(?:哪一|哪个|何种|什么)[^，。？?]{0,16}(?:最高|最低|最大|最小|最多|最少)|\bwhich\s+(?:one|option|plan|vendor|supplier|model|department|product|item|risk|category|strategy)\s+(?:is|has)\s+(?:the\s+)?(?:highest|lowest|largest|smallest|most|least|best|worst)\b/iu;

export const PROSE_DIFF_COMPARE_PATTERN =
	/(?:有何不同|有哪些不同|主要差异|有哪些差异|异同点?|相比(?:较|而言)?[^，。？?]{0,20}(?:如何|怎样|更大|更小|更高|更低|差异|区别)|对比[^，。？?]{0,36}(?:差异|区别|不同|策略|优势|前景)|比较[^，。？?]{0,36}(?:差异|区别|不同|优劣|异同)|\b(?:compare|comparison|versus|vs\.?|differences?\s+between|differ(?:s|ent)?\s+from|how\s+(?:does|do)\s+.{1,48}\s+compare)\b)/iu;

const SUMMARY_INTENT_PATTERN =
	/(?:(?:请|帮我|简要|整体|全面|系统)?(?:总结|概括|综述|概览|提炼|梳理|归纳|简述)(?:一下|出|这份|该|上述|文档|文件|报告|合同|方案|内容|要点|核心)?|(?:主要内容|核心内容|核心要点|总体概览|核心结论|内容大意)(?:是什么|有哪些)?|\b(?:summarize|summarise|summary\s+of|give\s+(?:me\s+)?an?\s+overview|overview\s+of|key\s+takeaways?|main\s+points?|tl;?dr|recap|high-level\s+summary)\b)/iu;

const FOLLOW_UP_PREFIX_PATTERN =
	/^(?:那|那么|这个|它|上述|前者|后者|还有|为什么|具体呢|分别呢)/u;

const SHORT_FOLLOW_UP_SUFFIX_PATTERN = /(?:呢|吗)[？?]?$/u;

const MULTI_ASPECT_FACT_PATTERN =
	/(?:对比|比较|差异|以及|并且|有哪些|分别|应对|措施|战略|合作伙伴|\b(?:as\s+well\s+as|in\s+addition\s+to|and\s+also|both\s+\S.{1,32}\s+and\s+\S)\b)/iu;

const TRIVIAL_AMBIGUOUS_ZH_PATTERN =
	/^(?:这个|那个|这些|那些|它|它们|他|他们|她|她们|上述|前者|后者|这|那|什么|怎么|为什么|啥|呢|吗|嗯|哦|啊|好|好的|你好|您好|嗨|哈喽|谢谢|感谢|帮助|测试|继续|展开|详细)$/;

const TRIVIAL_AMBIGUOUS_EN_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"but",
	"can",
	"continue",
	"do",
	"does",
	"for",
	"hello",
	"help",
	"hey",
	"hi",
	"how",
	"i",
	"in",
	"is",
	"it",
	"its",
	"me",
	"more",
	"no",
	"ok",
	"okay",
	"or",
	"please",
	"test",
	"thank",
	"thanks",
	"that",
	"the",
	"them",
	"these",
	"they",
	"this",
	"those",
	"to",
	"we",
	"what",
	"when",
	"where",
	"which",
	"who",
	"why",
	"yes",
	"you",
]);

const SHORT_DOMAIN_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_./-]{1,31}$/;

const SAFE_ROUTE_REASON_CODE = /^[a-z0-9_:-]{1,64}$/;

export function isFigureProseQuestion(question: string): boolean {
	return FIGURE_PROSE_PATTERN.test(question);
}

export function isSummaryProseReference(question: string): boolean {
	return (
		SUMMARY_PROSE_PATTERN.test(question) &&
		!IGNORE_SUMMARY_PROSE_PATTERN.test(question)
	);
}

export function isExplicitTableStructureQuestion(question: string): boolean {
	return EXPLICIT_TABLE_STRUCTURE_PATTERN.test(question);
}

export function isCompareQuestion(question: string): boolean {
	return (
		PROSE_SUPERLATIVE_COMPARE_PATTERN.test(question) ||
		PROSE_DIFF_COMPARE_PATTERN.test(question)
	);
}

export function isSummaryQuestion(question: string): boolean {
	if (isSummaryProseReference(question)) return false;
	return SUMMARY_INTENT_PATTERN.test(question);
}

export function isMultiAspectFactQuestion(question: string): boolean {
	return MULTI_ASPECT_FACT_PATTERN.test(question);
}

function stripQueryPunctuation(question: string): string {
	return question
		.normalize("NFKC")
		.trim()
		.replace(/[\s？?！!。，,.;；:：'"“”‘’()（）[\]【】]+/gu, "");
}

export function isTrivialAmbiguousInput(question: string): boolean {
	const core = stripQueryPunctuation(question);
	if (!core) return true;
	if (TRIVIAL_AMBIGUOUS_ZH_PATTERN.test(core)) return true;
	const lowerWords = question
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (
		lowerWords.length > 0 &&
		lowerWords.length <= 2 &&
		!/\p{Script=Han}/u.test(question) &&
		lowerWords.every((word) => TRIVIAL_AMBIGUOUS_EN_WORDS.has(word))
	) {
		return true;
	}
	return false;
}

export function isShortDomainIdentifier(question: string): boolean {
	const core = question
		.normalize("NFKC")
		.trim()
		.replace(
			/^[\s？?！!。，,.;；:：'"“”‘’()（）[\]【】]+|[\s？?！!。，,.;；:：'"“”‘’()（）[\]【】]+$/gu,
			"",
		);
	if (!SHORT_DOMAIN_IDENTIFIER_PATTERN.test(core)) return false;
	return !TRIVIAL_AMBIGUOUS_EN_WORDS.has(core.toLowerCase());
}

/**
 * Sanitize a router reason before writing to metadata-only observability storage.
 * Never allows arbitrary model-generated prose or user text to enter ask_run_stages.
 */
export function sanitizeRouteReasonCode(
	reason: string | undefined,
): string | null {
	if (typeof reason !== "string") return null;
	const head = reason.split(":")[0]?.trim().toLowerCase() ?? "";
	if (SAFE_ROUTE_REASON_CODE.test(reason.trim().toLowerCase())) {
		return reason.trim().toLowerCase();
	}
	return SAFE_ROUTE_REASON_CODE.test(head) ? head : null;
}

/**
 * Ultra-thin, cross-domain, EN/ZH pre-retrieval router.
 *
 * Intentionally avoids domain/customer-specific vocabulary and premature table
 * guessing: implicit table lookups and operations remain on the unified recall
 * path and upgrade only after real table evidence is retrieved and verified.
 */
export function thinPreRetrievalRoute(
	question: string,
	historyCount = 0,
): ThinRouteDecision {
	const normalized = question.trim();
	if (isFormFieldLookup(normalized)) {
		return {
			queryType: "fact",
			reason: "structured_router_fallback_form_field",
			layer: "thin_rule",
			grayZone: false,
		};
	}
	if (isProseChecklistLookup(normalized)) {
		return {
			queryType: "fact",
			reason: "structured_router_fallback_checklist_prose",
			layer: "thin_rule",
			grayZone: false,
		};
	}
	if (
		!isDerivedCalculationQuestion(normalized) &&
		!isFigureProseQuestion(normalized) &&
		!isSummaryProseReference(normalized) &&
		(isExplicitTableStructureQuestion(normalized) ||
			isFormTableOperation(normalized))
	) {
		return {
			queryType: "table",
			reason: "structured_router_fallback_table",
			layer: "thin_rule",
			grayZone: false,
		};
	}
	if (
		historyCount > 0 &&
		(FOLLOW_UP_PREFIX_PATTERN.test(normalized) ||
			hasFollowupReference(normalized) ||
			(Array.from(normalized).length <= 12 &&
				SHORT_FOLLOW_UP_SUFFIX_PATTERN.test(normalized)))
	) {
		return {
			queryType: "follow_up",
			reason: "structured_router_fallback_follow_up",
			layer: "thin_rule",
			grayZone: false,
		};
	}
	if (
		!isDerivedCalculationQuestion(normalized) &&
		!isFigureProseQuestion(normalized) &&
		isCompareQuestion(normalized)
	) {
		return {
			queryType: "compare",
			reason: "thin_router_compare",
			layer: "thin_rule",
			grayZone: false,
		};
	}
	if (
		!isDerivedCalculationQuestion(normalized) &&
		!isFigureProseQuestion(normalized) &&
		isSummaryQuestion(normalized)
	) {
		return {
			queryType: "summary",
			reason: "thin_router_summary",
			layer: "thin_rule",
			grayZone: false,
		};
	}
	if (isTrivialAmbiguousInput(normalized)) {
		return {
			queryType: "ambiguous",
			reason: "structured_router_fallback_ambiguous",
			layer: "thin_rule",
			grayZone: false,
		};
	}
	if (isShortDomainIdentifier(normalized)) {
		return {
			queryType: "fact",
			reason: "thin_router_short_entity_fact",
			layer: "thin_rule",
			grayZone: false,
		};
	}
	if (Array.from(normalized).length >= 4) {
		return {
			queryType: "fact",
			reason: "structured_router_fallback_fact",
			layer: "thin_rule",
			grayZone: false,
		};
	}
	return {
		queryType: "ambiguous",
		reason: "structured_router_fallback_ambiguous",
		layer: "thin_rule",
		grayZone: true,
	};
}

export const DEFAULT_GRAY_ZONE_ROUTER_TIMEOUT_MS = 1_500;
export const DEFAULT_GRAY_ZONE_MIN_CONFIDENCE = 0.6;

/**
 * Optional bounded System-1 gray-zone classifier with strict timeout and fail-open fallback.
 * Supports calibrated classifiers (such as Jev Choice) as well as lightweight LLM routers.
 */
export async function resolveGrayZoneRoute(input: {
	thin: ThinRouteDecision;
	question: string;
	history: AskHistoryMessage[];
	libraryId: string | null;
	decisionRouter: DecisionRouterPort;
	signal?: AbortSignal;
	timeoutMs?: number;
	minConfidence?: number;
}): Promise<ThinRouteDecision> {
	if (!input.thin.grayZone) return input.thin;
	const timeoutMs = input.timeoutMs ?? DEFAULT_GRAY_ZONE_ROUTER_TIMEOUT_MS;
	const minConfidence = input.minConfidence ?? DEFAULT_GRAY_ZONE_MIN_CONFIDENCE;
	const timeoutController = new AbortController();
	const combinedSignal = input.signal
		? AbortSignal.any([input.signal, timeoutController.signal])
		: timeoutController.signal;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const decision = await Promise.race([
			input.decisionRouter.classify({
				question: input.question,
				history: input.history,
				libraryId: input.libraryId,
				signal: combinedSignal,
			}),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					timeoutController.abort(new Error("gray_zone_router_timeout"));
					reject(new Error("gray_zone_router_timeout"));
				}, timeoutMs);
			}),
		]);
		const candidateType = decision.queryType?.trim() as
			| ThinRouteDecision["queryType"]
			| undefined;
		if (!candidateType || !VALID_ROUTER_QUERY_TYPES.has(candidateType)) {
			return {
				...input.thin,
				layer: "gray_zone_fallback",
			};
		}
		if (
			typeof decision.confidence === "number" &&
			(!Number.isFinite(decision.confidence) ||
				decision.confidence < minConfidence)
		) {
			return {
				...input.thin,
				layer: "gray_zone_fallback",
			};
		}
		const providerTag = sanitizeRouteReasonCode(decision.provider);
		return {
			queryType: candidateType,
			reason: providerTag
				? `gray_zone_${providerTag}`
				: "gray_zone_model_route",
			layer: "gray_zone_model",
			grayZone: false,
		};
	} catch (error) {
		if (input.signal?.aborted) throw error;
		if (
			error instanceof AiConcurrencyOverloadedError ||
			error instanceof AiConcurrencyWaitTimeoutError
		) {
			throw error;
		}
		return {
			...input.thin,
			layer: "gray_zone_fallback",
		};
	} finally {
		if (timer) clearTimeout(timer);
	}
}
