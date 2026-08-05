import { createHash } from "node:crypto";

export const PROMPT_KEYS = [
	"chat",
	"router",
	"rewrite",
	"judge",
	"table_plan",
] as const;

export type PromptKey = (typeof PROMPT_KEYS)[number];

export interface VersionedPrompt {
	readonly key: PromptKey;
	readonly name: string;
	readonly version: `${number}.${number}.${number}`;
	readonly text: string;
	readonly digest: string;
}

type PromptDefinition = Omit<VersionedPrompt, "digest">;

/** Append-only review manifest: a prompt text change requires a new version. */
export const PROMPT_VERSION_HISTORY = Object.freeze({
	chat: Object.freeze({
		"1.0.0": "1844dc7b6bad62e3d3b06b8ea5818a5ea6ccedf475baa29c682b45fae7026132",
		"1.1.0": "0ce38d37e4cbfc6ac34def9b5ca78fcdbc1a54a480c9b1a65ce11b83631c5696",
		"1.2.0": "0b9386aad530cc800bd97fd1cce4ca79eaeb1a4eb603fd3a8fbcd38ae4c46690",
	}),
	router: Object.freeze({
		"1.0.0": "4f586e259c1fb7b4991d7014038887dd885168785edfd5fe0705cfb8a5862353",
	}),
	rewrite: Object.freeze({
		"1.0.0": "81002875e2bfbf97afaee365f896b5a7a7c6528cea3c2242c4e26a40ab7d4104",
	}),
	judge: Object.freeze({
		"1.0.0": "e7021ca6445ae3a89d24eb88650f3c5124edc06b4c5520370c183f2c0d7e7870",
		"1.1.0": "f8671487f0b6fbe394a45718989ba81a7837370466468138ecb7feb21931e1bb",
	}),
	table_plan: Object.freeze({
		"1.0.0": "074c2f67f29bc44f7a72be0b1525490ef51719be3a9ba9ac4677b33198d5aab7",
	}),
} satisfies Record<PromptKey, Readonly<Record<string, string>>>);

function definePrompt(definition: PromptDefinition): VersionedPrompt {
	const digest = createHash("sha256")
		.update(definition.text, "utf8")
		.digest("hex");
	const history = PROMPT_VERSION_HISTORY[definition.key] as Readonly<
		Record<string, string>
	>;
	const expected = history[definition.version];
	if (expected !== digest) {
		throw new Error(
			`Prompt ${definition.key}@${definition.version} is not registered in version history`,
		);
	}
	return Object.freeze({
		...definition,
		digest,
	});
}

export const PROMPT_REGISTRY = Object.freeze({
	chat: definePrompt({
		key: "chat",
		name: "unorag.chat.answer",
		version: "1.2.0",
		text:
			"你是 UnoRAG 企业知识库助手：根据已收录资料回答，并便于核对原文。" +
			"只根据「资料」回答；资料没写到的内容直接说「资料未覆盖」，不要编造。" +
			"只回答用户所问，不要主动列举「未使用的技术 / 未提及的框架」等对比注脚；" +
			"除非用户明确问技术对比或用了哪些框架。" +
			"直接覆盖问题中的每个子问，保留资料中的数字、单位和型号原文，不做无关计算或延伸；" +
			"不得省略或改写影响事实边界的限定词，例如超过、突破、至少、至多、约、近、余；" +
			"回答最高、最低、最大、最小等比较问题时，必须比较资料中所有候选项的显式数值并按数值作答；不得根据标题顺序、出现次数或定性等级臆断排序；" +
			"语气简洁专业，用中文，通常不超过300字；必要时分点。引用资料时可用 [1]、[2] 对应来源编号。" +
			"若有多轮对话历史，结合上文理解指代与追问，但仍以当前资料为准。",
	}),
	router: definePrompt({
		key: "router",
		name: "unorag.query.router",
		version: "1.0.0",
		text:
			"你是 UnoRAG 查询路由器。仅输出结构化结果。分类只能是 fact、follow_up、summary、compare、table、section_lookup、ambiguous；不执行检索，不生成答案。" +
			"涉及表格明细的筛选、排序、最大最小、合计、平均、计数、逐行比较或按序号定位必须分类为 table；compare 仅用于多个文档、段落或实体之间的非表格比较。",
	}),
	rewrite: definePrompt({
		key: "rewrite",
		name: "unorag.query.rewrite",
		version: "1.0.0",
		text: "你是检索计划助手。semantic_query 可对原问做检索友好改写；无把握则原样。filters 只允许 record_type、doc_id、table_id、document_version_id；普通正文检索保持调用方给出的默认 record_type，不要擅自切换为 table。不要编造标识，不要输出 tenant_id、workspace_id、library_id、generation 或 ACL 字段。",
	}),
	judge: definePrompt({
		key: "judge",
		name: "unorag.evidence.judge",
		version: "1.1.0",
		text:
			"你是证据充分性判断器。仅根据给定候选证据判断 generate、retry 或 refuse。" +
			"资料未覆盖时必须 refuse，不能用模型常识补足。问题澄清由查询路由器负责，不输出 clarify。" +
			"同时输出 evidence_ids：generate 时必须从候选证据的真实 id 中选择一至六条能够完整支持回答的最小证据集合；" +
			"不得编造 id，不得选择与问题无关或仅主题相似的证据。retry 或 refuse 时 evidence_ids 必须为空数组。",
	}),
	table_plan: definePrompt({
		key: "table_plan",
		name: "unorag.table.plan",
		version: "1.0.0",
		text:
			"你是表格执行计划器。只根据问题和真实表头制定严格计划；列名必须逐字来自所给表头。" +
			"单表使用 mode=single，同时询问同一列最小值和最大值时使用 minMax；计数问题若同时询问表头或列名，设置 includeHeaders=true；双表显式给出 join 键；无法确定列名、连接键或运算时不要猜测，由调用方拒答或澄清。",
	}),
} satisfies Record<PromptKey, VersionedPrompt>);

export function getPrompt(key: PromptKey): VersionedPrompt {
	return PROMPT_REGISTRY[key];
}

export function promptSpanAttributes(
	prompt: VersionedPrompt,
): Record<string, string> {
	return {
		"langfuse.observation.metadata.prompt_name": prompt.name,
		"langfuse.observation.metadata.prompt_version": prompt.version,
		"langfuse.observation.metadata.prompt_digest": prompt.digest,
	};
}
