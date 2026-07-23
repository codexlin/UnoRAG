# MeriKnow 企业级 RAG SaaS 架构设计

> 状态：Draft（Phase 1 已收口；Phase 2A section + Phase 2B table 多粒度已落地；eval 基线约 38 条）
> 日期：2026-07-23  
> 目标：把 MeriKnow 从「可演示的企业知识问答 MVP」推进为「可治理、可评测、可扩展、可隔离」的企业级 RAG SaaS 知识库平台。

## 1. 结论

MeriKnow 当前已经具备企业级 RAG 的正确骨架：FastAPI + LangGraph 问答编排、Postgres 元数据、Qdrant 向量库、结构化文档入库管线、流式回答、引用溯源、弱相关拒答、可选 hybrid / rerank。

但它还不是企业级 SaaS 的完成态。真正的企业级 RAG 不是「文件上传 + embedding + chat」，而是一个完整工程系统：

- 文档摄取要能处理多格式、多结构、多失败形态。
- 切片要根据文档类型和结构选择策略，而不是统一字符窗。
- 索引要支持多粒度、多路召回、权限过滤、版本过滤。
- 查询要理解意图，并按意图走不同检索和生成路径。
- 回答要可引用、可拒答、可审计、可复现。
- 质量要靠评测闭环驱动，而不是只靠人工感觉。
- SaaS 层要具备租户隔离、RBAC、审计、队列、监控、成本治理和合规删除。

因此本文档将 MeriKnow 的目标架构定义为：

```text
Connectors / Upload
  -> Ingestion Router
  -> Format Parsers
  -> Document IR
  -> Structure-aware Chunking
  -> Multi-granularity Indexing
  -> Query Router
  -> Retrieval Plan
  -> Rerank / Evidence Judge
  -> Grounded Generation
  -> Citation / Archive / Audit
  -> Evaluation / Feedback Loop
```

## 2. 设计原则

### 2.1 证据优先

企业用户要的不是「看起来合理的回答」，而是「能核对、能追责、能复现的回答」。任何答案都必须绑定来源。没有足够证据时，应拒答或提示资料未覆盖，而不是让模型补全。

落地要求：

- 每个 citation 至少包含 `doc_id`、`library_id`、`chunk_id`、`page` 或 `section_path`、`snippet`。
- 生成阶段只能使用检索到的 evidence context。
- 弱相关、无命中、证据冲突要进入正式拒答或澄清路径。
- archive 保存问题、答案、引用、检索模式、拒答原因和关键 debug 信息。

### 2.2 结构优先，而不是 embedding 迷信

不同文档的知识结构不同。制度文档、合同、PDF 报告、Word 手册、表格、Markdown 技术文档，不应该用同一种 chunking 方法。

设计原因：

- 固定字符窗容易跨章节、跨页、跨表，导致引用不可读。
- embedding semantic split 适合部分长文本，但不适合作为所有格式默认策略。
- 企业文档天然有标题、条款、表格、页码、版本、附件关系，应尽量保留。

落地要求：

- MD / DOCX 优先按 heading、列表、表格、代码块切。
- PDF 优先按页、章、段落切，扫描页明确失败或 OCR。
- 表格独立处理，必要时行组索引和结构化字段索引并存。
- 长无结构文本才退回 recursive / char window。
- embedding 文本可包含 preamble，UI 引用展示 body。

### 2.3 多策略召回

企业 RAG 不能只依赖 dense vector。dense 擅长语义近似，BM25 擅长关键词和编号，rerank 擅长精排，metadata filter 负责边界和权限。

目标召回应由多个阶段组成：

```text
query
  -> rewrite / normalize
  -> metadata filter
  -> dense retrieve
  -> sparse retrieve
  -> optional structured retrieve
  -> fusion
  -> rerank
  -> evidence judge
```

设计原因：

- 制度编号、产品型号、人名、合同条款常常靠关键词更可靠。
- 跨文档总结需要 broader recall。
- 精确事实问答需要高置信 chunk。
- 表格类问题需要结构化查询，而不是只用向量。

### 2.4 查询先分类，再执行

不是所有问题都应该走 `retrieve -> generate`。企业问答至少应区分：

| Query 类型 | 示例 | 推荐路径 |
|---|---|---|
| 简单事实 | 病假证明几天内补交？ | rewrite -> retrieve -> rerank -> answer |
| 追问 | 那逾期呢？ | session rewrite -> retrieve |
| 跨文档总结 | 总结本库的报销规则 | document / section recall -> map-reduce summary |
| 对比 | A 方案和 B 方案区别？ | multi-query -> grouped retrieval -> synthesis |
| 表格查询 | 哪些供应商报价超过 10 万？ | structured/table retrieval |
| 指定页/章节 | 第 3 章说了什么？ | read_section / read_page |
| 低置信 | 这个政策适用于海外员工吗？ | retrieve -> evidence judge -> refuse/clarify |

设计原因：

- 单一路径会让复杂问题召回不足。
- 无分类会让简单问题成本过高。
- 企业系统必须知道自己在执行什么类型的任务，才方便评测和审计。

### 2.5 评测闭环是核心功能

RAG 的质量不是靠主观聊天体验判断。企业级系统要持续回答这些问题：

- 召回是否命中了正确文档？
- 排名前几的 chunk 是否包含答案？
- 引用是否真的支持答案？
- 无资料时是否拒答？
- 新 parser / chunker / embedding 模型是否让质量变好？
- hybrid / rerank 是否值得开启？

因此 eval 不是附属脚本，而应成为架构内的一等能力。

## 3. 当前 MeriKnow 能力盘点

### 3.1 已有能力

| 能力 | 当前状态 | 评价 |
|---|---|---|
| Web 工作台 | 已有 `/app/ask`、`/app/libraries`、`/app/archive` | 产品骨架完整 |
| API | FastAPI + `/health` + `/v1` routers | 清晰 |
| 问答图 | LangGraph `rewrite -> retrieve -> judge -> retry -> generate/refuse` | 方向正确 |
| 流式回答 | SSE meta / citations / token / done | 用户体验良好 |
| 元数据 | Postgres required，JSON test-only | 比 demo 稳 |
| 向量库 | Qdrant | 合适 |
| 入库 | `DocumentIR` + v2 structure-aware chunking | 关键优势 |
| 格式 | txt / md / pdf / docx | MVP 足够 |
| 召回 | dense，optional BM25+RRF，optional rerank | 已有核心组件 |
| 拒答 | no hit / weak match | 重要 |
| 会话 | session memory + lightweight rewrite | 有基础 |
| 档案 | turns archive | 可审计雏形 |
| 测试 | API tests + eval skeleton | 需要扩展 |

### 3.2 主要差距

| 领域 | 差距 |
|---|---|
| SaaS | 缺 tenant、workspace、user、role、ACL |
| 权限检索 | 当前主要依赖 `library_id`，还不是用户级权限过滤 |
| Query Router | 追问 rewrite 有了，但缺 query classification 和 retrieval plan |
| 多粒度索引 | 主要 chunk 索引，缺 section summary、document summary、table row、entity index |
| 评测 | 缺完整黄金集、指标、回归门禁、线上反馈闭环 |
| 异步任务 | 已有 ingest async 设置和 jobs，但还需要生产级队列状态、重试、幂等、死信 |
| 观测 | 缺 tracing、latency、cost、token、retrieval quality dashboard |
| 合规 | 缺数据删除证明、版本保留策略、审计事件模型 |
| 运维 | 缺限流、配额、成本预算、模型 fallback 策略 |

## 4. 目标架构

### 4.1 分层视图

```text
┌─────────────────────────────────────────────────────────────┐
│ SaaS Layer                                                   │
│ tenant / workspace / user / role / billing / quota / audit   │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│ Knowledge Layer                                              │
│ libraries / documents / versions / metadata / ACL            │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│ Ingestion Layer                                              │
│ upload / connectors / parser router / Document IR / jobs     │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│ Index Layer                                                  │
│ dense / sparse / table / doc summary / section summary       │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│ Retrieval Layer                                              │
│ query rewrite / filters / fusion / rerank / evidence judge   │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│ Generation Layer                                             │
│ grounded answer / refuse / clarify / citation package        │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│ Evaluation and Observability                                 │
│ offline eval / online feedback / traces / cost / dashboards  │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 核心数据模型

#### Tenant / Workspace

```text
tenant
  id
  name
  plan
  created_at

workspace
  id
  tenant_id
  name
  settings
```

设计原因：

- 企业 SaaS 必须以 tenant 为隔离边界。
- workspace 方便支持一个企业多个部门或项目空间。

#### Identity / ACL

```text
user
  id
  tenant_id
  email
  display_name

group
  id
  tenant_id
  name

membership
  user_id
  group_id

acl_entry
  resource_type: library | document | folder
  resource_id
  subject_type: user | group | role
  subject_id
  permission: read | write | admin
```

设计原因：

- 企业问答最大的风险之一是越权回答。
- 权限不能只在 UI 控制，必须进入 retrieval filter。

#### Library / Document / Version

```text
library
  id
  tenant_id
  workspace_id
  name
  description
  status

document
  id
  tenant_id
  library_id
  current_version_id
  name
  filename
  content_type
  status

document_version
  id
  document_id
  version
  content_hash
  storage_key
  parser_report
  chunk_count
  created_by
  created_at
```

设计原因：

- 企业文档会更新，答案必须能说明引用的是哪个版本。
- 重索引不能破坏历史问答可复现性。

#### Chunk / Index Payload

```text
chunk
  id
  tenant_id
  library_id
  document_id
  document_version_id
  chunk_index
  body
  preamble
  section_path
  page_start
  page_end
  table_id
  split_strategy
  content_hash
```

Qdrant payload 必须至少包含：

```text
tenant_id
workspace_id
library_id
document_id
document_version_id
chunk_id
section_path
page_start
page_end
acl_scope or allowed_group_ids
source_format
split_strategy
```

设计原因：

- 检索过滤必须在向量库层执行，不能检索后再丢弃越权结果。
- chunk 要能回溯到版本和原文。

### 4.3 LangChain / LangGraph 融合设计

MeriKnow 不应该把 LangChain / LangGraph 当作「包一层模型调用」的工具，也不应该为了使用框架而放弃自研核心数据模型。推荐定位是：

```text
MeriKnow domain model
  DocumentIR / Chunk / Metadata / ACL / Archive / Eval

LangChain abstraction
  Document / Retriever / Tool / Runnable / Output Parser / Callback

LangGraph orchestration
  Query Router / Retrieval Plan / Tool Path / Judge / Generate / Eval Graph
```

换句话说：

- **MeriKnow 负责业务真相**：文档版本、权限、parser_report、citation、archive、tenant、eval case。
- **LangChain 负责标准化接口**：LLM、embedding、retriever、tools、structured output、callbacks。
- **LangGraph 负责流程状态机**：多分支、多节点、多工具、多轮记忆、失败路径、流式事件、checkpoint。

#### 4.3.1 设计边界

| 层 | 继续自研 | 融入 LangChain | 融入 LangGraph |
|---|---|---|---|
| 文档模型 | `DocumentIR`、`Node`、`Chunk` | 转换为 LangChain `Document` | ingest eval graph 可消费 |
| Parser | 格式分流、PDF/DOCX/MD 解析 | 可选复用 loaders，但输出必须归一到 IR | 不放进 ask graph |
| Chunking | 结构优先 chunker | 可作为 DocumentTransformer 包装 | ingest graph 可编排 |
| Embedding | 模型配置、批处理、维度校验 | 使用 Embeddings 接口或兼容 wrapper | ingest graph 节点 |
| Retrieval | 权限 filter、hybrid、Qdrant payload | 实现 BaseRetriever / Runnable | retrieval 节点和工具 |
| Rerank | provider client、fallback | Runnable reranker | rerank 节点 |
| Query 理解 | query type schema、业务规则 | structured output parser | query_router 节点 |
| Evidence Judge | 证据规则、拒答策略 | structured output parser | evidence_judge 节点 |
| Tools | read_section/read_page/extract_table | LangChain Tool | tool subgraph |
| Memory | session / archive / tenant context | message history adapter | checkpoint / state |
| Eval | golden set、指标 | evaluator runnable | eval graph |
| Observability | trace schema、成本字段 | callbacks / tracing hooks | node-level events |

设计原因：

- 企业 RAG 的领域对象必须稳定，不能被框架版本牵着走。
- LangChain 的价值在接口生态，不在替代业务模型。
- LangGraph 的价值在显式状态、条件路由和可观测执行，不只是把函数串起来。

#### 4.3.2 LangChain 适配层

新增一个薄适配层，把 MeriKnow 内部对象转换为 LangChain 可组合对象：

```text
apps/api/app/langchain_adapters/
  documents.py        # Chunk <-> LangChain Document
  retrievers.py       # MeriKnowHybridRetriever
  tools.py            # search_docs/read_section/read_page/extract_table
  outputs.py          # Pydantic structured output schemas
  callbacks.py        # trace/cost callback bridge
```

`Chunk` 转 LangChain `Document` 的约定：

```text
Document.page_content = chunk.body
Document.metadata = {
  tenant_id,
  workspace_id,
  library_id,
  document_id,
  document_version_id,
  chunk_id,
  title,
  filename,
  section_path,
  page_start,
  page_end,
  table_id,
  split_strategy,
  preamble,
  score fields
}
```

注意：`page_content` 不放 preamble，保持「用户看见的文本」；embedding 时使用 `preamble + body` 是 indexing 阶段的策略，不污染引用展示。

#### 4.3.3 Retriever 重新设计

当前 `RetrievalService.search()` 可以保留，但外层应增加 LangChain Retriever 适配器：

```text
MeriKnowHybridRetriever
  input:
    query
    retrieval_plan
    tenant_context
  steps:
    dense search
    bm25 search
    RRF fusion
    optional rerank
    citation normalization
  output:
    list[Document]
```

推荐拆分：

```text
DenseRetriever
SparseRetriever
HybridFusionRetriever
RerankRetriever
PermissionFilteredRetriever
```

但不要过早把每个类都做复杂继承。第一阶段可以只有一个 `MeriKnowHybridRetriever`，内部继续调用现有 `RetrievalService`，对外暴露 LangChain Runnable / Retriever 接口。

设计原因：

- 现有业务逻辑不需要推倒重来。
- 后续可以接 LangChain 的 MultiQuery、compression、callbacks、eval。
- 统一 retriever 接口后，LangGraph 节点和 tools 都能复用同一检索能力。

#### 4.3.4 Structured Output 重新设计

Query Router、Evidence Judge、Answer Verifier 不应返回自由文本，应返回 Pydantic schema。

Query Router 输出：

```text
QueryRoute
  query_type: fact | follow_up | summary | compare | table | section_lookup | page_lookup | ambiguous
  rewritten_question
  subqueries[]
  needs_tools: bool
  target_sections[]
  target_pages[]
  retrieval_policy
```

Evidence Judge 输出：

```text
EvidenceJudgement
  sufficient: bool
  action: generate | retry | refuse | clarify
  reason: ok | no_hit | weak_match | conflict | ambiguous | permission_limited
  confidence: float
  missing_evidence[]
```

Answer Verifier 输出：

```text
AnswerVerification
  grounded: bool
  unsupported_claims[]
  citation_coverage: float
  final_action: accept | revise | refuse
```

设计原因：

- 图节点之间传结构化状态，方便测试、archive、eval。
- prompt 调整不影响外部契约。
- 后续可以替换规则分类器、LLM 分类器或小模型分类器。

#### 4.3.5 LangGraph Ask Graph 目标形态

当前图：

```text
rewrite -> retrieve -> judge -> retry -> generate/refuse
```

目标图：

```text
start
  -> load_context
  -> query_router
  -> build_retrieval_plan
  -> route_by_query_type

fact path:
  retrieve -> rerank -> evidence_judge -> generate/refuse

follow_up path:
  rewrite_with_memory -> retrieve -> rerank -> evidence_judge -> generate/refuse

summary path:
  retrieve_documents -> retrieve_sections -> synthesize_summary -> verify -> done

compare path:
  decompose -> retrieve_per_subquery -> group_evidence -> synthesize_compare -> verify -> done

table path:
  search_tables -> extract_table -> answer_table_question -> verify -> done

section/page path:
  read_section/read_page -> generate_with_exact_context -> done

ambiguous path:
  clarify
```

Graph state：

```text
AskState
  request_id
  tenant_context
  user_context
  session_id
  question
  history
  query_route
  retrieval_plan
  rewritten_question
  subqueries
  documents
  citations
  judgement
  answer
  verification
  refused
  refuse_reason
  trace
```

设计原因：

- 简单事实问答继续短路径，保证低延迟。
- 复杂问题不再硬塞进一次 retrieve。
- 每个节点可记录耗时、输入、输出和失败原因。

#### 4.3.6 Tool Calling 设计

工具不是为了做“聊天 Agent”，而是为了让复杂 RAG 任务有可控动作。

推荐工具：

| Tool | 输入 | 输出 | 用途 |
|---|---|---|---|
| `search_docs` | query, filters, top_k | citations | 普通召回 |
| `read_section` | document_id, section_path | section text | 完整条款读取 |
| `read_page` | document_id, page | page text | PDF 页级问题 |
| `extract_table` | document_id, table_id | table json/text | 表格问题 |
| `quote_source` | citation ids | normalized citations | 生成前统一引用 |

这些 tools 应使用 LangChain Tool 接口包装，但底层仍调用 MeriKnow 的 metadata、storage、retrieval 服务。

设计原因：

- 工具边界清楚，便于权限检查。
- LangGraph 可以按 query_type 决定是否启用工具。
- 工具调用轨迹可进入 archive 和 eval。

#### 4.3.7 Checkpoint 与 Memory

LangGraph checkpoint 适合保存 graph run 状态，但不应替代业务 archive。

推荐分工：

| 存储 | 用途 |
|---|---|
| SessionMemory | 最近几轮对话，服务 rewrite |
| LangGraph checkpoint | graph run 恢复、长链路状态 |
| Archive turns | 用户可见历史、审计、复现 |
| Eval traces | 离线评测和质量回归 |

设计原因：

- checkpoint 偏执行恢复。
- archive 偏产品和审计。
- memory 偏当前会话上下文。

#### 4.3.8 Streaming 与事件设计

当前 SSE 已有 `meta/citations/token/done`。融合 LangGraph 后应扩展为节点级事件：

```text
route
retrieval_plan
retrieval_start
retrieval_result
rerank_result
judge_result
tool_call
tool_result
citations
token
verification
done
error
```

前端可以先只展示 `citations/token/done`，高级调试面板再展示完整 trace。

设计原因：

- 用户体验保持简洁。
- 工程排障和 eval 有完整信息。

#### 4.3.9 Eval Graph

评测也应该用 LangGraph 表达，而不是散落脚本：

```text
eval_case
  -> ensure_fixture_ingested
  -> run_query_graph
  -> score_retrieval
  -> score_citation
  -> score_answer
  -> score_refusal
  -> write_eval_result
```

LangChain 可承载 evaluator runnable，MeriKnow 负责指标定义和结果存储。

设计原因：

- 评测链路和真实 ask 链路共享核心节点。
- 每次架构调整都可以量化比较。

#### 4.3.10 迁移策略

不要一次性重写现有 ask graph。建议三步走（顺序对齐 §19：先 router / plan / judge / eval，adapters 后置）：

1. **扩图，不改 API**：把 `query_router`、`build_retrieval_plan`、`evidence_judge` 加入 LangGraph，并接通本地 eval；HTTP 响应 schema 尽量兼容。
2. **分流，保短路径**：fact / follow_up 仍走低延迟短路径；Phase 1 对 summary / compare / table / ambiguous 只分类并记录 `RetrievalPlan`，执行仍落短路径或 clarify，不建对应子图（完整分流属后续阶段）。
3. **适配，不替换（后置、非阻塞）**：在以上接口稳定后，再新增 LangChain retriever/tool/output adapters，内部继续调用现有服务。目标形态仍可保留 `langchain_adapters/`，但不阻塞 Phase 1 Done。

这样能最大化利用 LangChain / LangGraph，同时避免框架化重构把现有可用能力打散。

## 5. 文档摄取设计

### 5.1 摄取流程

```text
Upload / Connector
  -> create ingest_job
  -> store original file
  -> detect file type
  -> parse to DocumentIR
  -> validate parser_report
  -> chunk by strategy
  -> generate embeddings
  -> write dense index
  -> write sparse / BM25 corpus
  -> write structured indexes
  -> mark document ready / partial / failed
```

### 5.2 为什么需要 DocumentIR

DocumentIR 是所有格式进入系统后的统一中间表示。它的价值是：

- 后续 chunker 不需要直接理解 PDF、DOCX、MD。
- citation 可以绑定 node、section、page。
- parser_report 可以统一表达失败和 partial 状态。
- 后续可增加 xlsx、pptx、html、confluence 等格式，不影响问答层。

当前 MeriKnow 已经有 `DocumentIR`，应继续把它作为文档处理的核心契约。

### 5.3 分格式策略

| 格式 | Parser | Chunk 策略 | Index 策略 |
|---|---|---|---|
| TXT | 编码探测、段落识别 | 段落合并，长段 recursive | dense + sparse |
| MD | heading / list / code / table | heading subtree，代码和表独立 | dense + sparse + table |
| DOCX | styles / paragraphs / tables | heading style，表格独立 | dense + sparse + table |
| PDF text | page text + layout hints | page first，章/段落 second | dense + sparse |
| PDF scan | OCR | page OCR，低置信标记 | dense + sparse，保留 confidence |
| PDF complex | text + optional VLM | page / figure summary | dense + figure metadata |
| CSV / XLSX | sheet / table parser | row groups / sheet summary | structured + dense summary |
| PPTX | slide parser | slide-level chunks | dense + slide metadata |

### 5.4 parser_report 设计

每次入库必须写 parser_report：

```json
{
  "source_format": "pdf",
  "parser": "pymupdf",
  "text_pages": [1, 2, 3],
  "ocr_pages": [],
  "failed_pages": [4],
  "needs_ocr_pages": [4],
  "partial": true,
  "warnings": ["page 4 requires OCR"]
}
```

设计原因：

- 企业用户要知道哪些内容没被系统读懂。
- partial ready 比静默 ready 更诚实。
- eval 和排障都依赖 parser_report。

## 6. Chunking 与 Embedding 策略

### 6.1 Chunking 策略顺序

默认顺序：

```text
format structure
  -> heading / section boundary
  -> table / code / figure special handling
  -> paragraph / page boundary
  -> recursive split
  -> char window fallback
```

禁止把 char window 作为所有格式的唯一默认策略。

### 6.2 Preamble + Body

Embedding 输入：

```text
文档《员工手册》 · 第 3 章 考勤 · 第 12 条 · 第 5 页

病假须于返岗后三个工作日内补交证明材料...
```

UI 引用展示：

```text
病假须于返岗后三个工作日内补交证明材料...
```

设计原因：

- embedding 需要上下文，否则短条款召回差。
- 用户引用需要原文，不应被系统补充的 preamble 污染。

### 6.3 多粒度索引

目标索引不应只有 chunk：

| 粒度 | 用途 |
|---|---|
| chunk | 精确事实问答 |
| section | 章节级总结、完整条款读取 |
| document summary | 跨文档发现、粗召回 |
| table row / table summary | 表格查询 |
| entity / keyword | 人名、产品、合同号、制度编号 |

推荐流程：

```text
query
  -> doc summary recall when broad
  -> section recall when chapter-level
  -> chunk recall when fact-level
  -> table recall when structured
```

## 7. Retrieval 设计

### 7.1 Query Pipeline

```text
raw question
  -> normalize
  -> detect language
  -> load session context
  -> classify intent
  -> rewrite / decompose
  -> build filters
  -> execute retrieval plan
  -> fuse
  -> rerank
  -> evidence judge
```

### 7.2 Query Classification

新增 `QueryRouter`：

```text
QueryType:
  fact
  follow_up
  summary
  compare
  table
  section_lookup
  page_lookup
  ambiguous
```

每种类型输出 retrieval plan：

```json
{
  "query_type": "compare",
  "rewritten_queries": ["A 方案 优缺点", "B 方案 优缺点"],
  "retrievers": ["dense", "bm25"],
  "filters": {
    "tenant_id": "...",
    "library_id": "...",
    "allowed_groups": ["..."]
  },
  "top_k": 20,
  "rerank": true,
  "evidence_policy": "multi_source"
}
```

设计原因：

- 让系统对自己的行为可解释、可测评。
- 后续可以按 query_type 做质量指标和成本控制。

### 7.3 Retrieval Filters

所有检索必须带过滤条件：

```text
tenant_id
workspace_id
library_id
document_status = ready
document_version_id = current or selected
user ACL
optional metadata filters
```

设计原因：

- 权限边界是企业 SaaS 的底线。
- 过滤越早越安全，越节省成本。

### 7.4 Fusion 与 Rerank

推荐默认策略：

```text
dense top 30
bm25 top 30
metadata boost
RRF fusion top 20
rerank top 8
evidence judge top 4-6
```

设计原因：

- dense 和 sparse 互补。
- RRF 简单稳定，不依赖分数可比性。
- rerank 只对融合后小集合执行，控制成本。

## 8. Evidence Judge 与拒答

### 8.1 Judge 输入

```text
question
rewritten_question
citations
top_score
rerank_score
query_type
library_id
session_context
```

### 8.2 Judge 输出

```json
{
  "sufficient": false,
  "reason": "weak_match",
  "action": "refuse",
  "confidence": 0.32,
  "missing": ["没有资料说明海外员工适用范围"]
}
```

### 8.3 拒答类型

| 类型 | 含义 | 用户体验 |
|---|---|---|
| no_hit | 没有召回结果 | 资料未覆盖 |
| weak_match | 有结果但相关性低 | 当前资料不足以回答 |
| conflict | 多来源冲突 | 展示冲突并建议人工核对 |
| permission_limited | 用户无权限访问相关资料 | 提示无可用资料，不泄露存在性 |
| ambiguous | 问题不清楚 | 追问澄清 |

设计原因：

- 拒答不是失败，是可信系统的核心能力。
- 不同拒答原因要进入 eval 和产品分析。

## 9. Generation 设计

### 9.1 Grounded Answer Contract

生成层必须遵守：

- 只使用 evidence context。
- 每个关键结论尽量带 citation。
- 不确定就说明资料未覆盖。
- 不输出检索不到的制度、数字、日期。
- 对表格结果保留字段名和来源。

### 9.2 Answer Schema

```json
{
  "answer": "...",
  "citations": [],
  "refused": false,
  "refuse_reason": null,
  "confidence": 0.82,
  "query_type": "fact",
  "retrieval_mode": "hybrid_rerank",
  "persisted": true
}
```

设计原因：

- UI、archive、eval 都需要结构化字段。
- 不能只返回一段自然语言。

## 10. Session Memory 与 Query Rewrite

### 10.1 Memory 分层

| 类型 | 存储 | 用途 |
|---|---|---|
| short-term turns | session memory | 追问 rewrite |
| archived turns | Postgres | 历史回看和审计 |
| user preferences | profile | 语言、格式偏好 |
| long-term semantic memory | 可选 | 不建议默认启用企业知识问答 |

### 10.2 Rewrite 规则

rewrite 不应该无限扩展上下文。推荐：

- 只取最近 3-6 轮。
- 只在短问、代词、承接问中启用。
- rewrite 结果必须保留原问题。
- archive 保存 rewrite debug。

设计原因：

- 过度 rewrite 会污染检索。
- 企业问答更重视可复现性。

## 11. Evaluation 设计

### 11.1 Eval 数据集

每个 eval case：

```json
{
  "id": "hr-leave-001",
  "library_id": "lib-hr",
  "question": "病假证明需要几天内补交？",
  "expected_answer_points": ["三个工作日内", "直属主管确认"],
  "expected_doc_ids": ["employee-handbook"],
  "expected_citations": [
    {
      "doc_id": "employee-handbook",
      "section_path": "休假/病假",
      "page": "p.12"
    }
  ],
  "should_refuse": false
}
```

### 11.2 指标

| 层 | 指标 |
|---|---|
| Ingestion | parse success rate, partial rate, chunk count drift |
| Retrieval | recall@k, MRR, nDCG, expected citation hit |
| Rerank | top1 accuracy, useful rerank delta |
| Refusal | false refusal rate, false answer rate |
| Generation | answer point coverage, citation faithfulness |
| Product | latency, cost, user feedback |

### 11.3 回归门禁

任何修改 parser、chunker、embedding、retrieval、rerank、prompt，都应跑 eval：

```text
baseline
  -> change
  -> eval
  -> compare metrics
  -> block if retrieval/citation/refusal regresses
```

设计原因：

- RAG 优化很容易局部变好、整体变坏。
- 没有 eval，架构讨论会变成感觉争论。

## 12. SaaS 与安全设计

### 12.1 多租户隔离

最低要求：

- 所有表带 `tenant_id`。
- 所有 API 请求解析 tenant context。
- 所有检索 payload 带 `tenant_id` filter。
- 后台任务也必须带 tenant context。
- 日志不能泄露跨租户内容。

### 12.2 RBAC / ACL

角色建议：

| 角色 | 权限 |
|---|---|
| owner | tenant 管理 |
| admin | workspace / library 管理 |
| editor | 上传和管理文档 |
| viewer | 查询和查看引用 |
| auditor | 查看 archive / audit |

ACL 应作用于：

- library
- document
- folder / connector source
- archive turns

### 12.3 审计事件

必须记录：

```text
document.uploaded
document.parsed
document.indexed
document.deleted
ask.submitted
ask.refused
answer.generated
citation.opened
library.permission_changed
```

设计原因：

- 企业场景需要追责和合规。
- 审计也能反哺产品质量分析。

## 13. 异步任务与可靠性

### 13.1 Ingest Job 状态机

```text
queued
  -> parsing
  -> chunking
  -> embedding
  -> indexing
  -> ready
  -> failed
  -> cancelled
```

支持：

- 幂等 job key：`document_version_id + content_hash + pipeline_version`
- 重试次数和错误分类
- dead letter
- 进度事件
- parser_report 可见
- 删除或替换时取消旧任务

### 13.2 为什么需要可靠队列

- PDF / OCR / embedding 可能耗时长。
- 用户上传多个大文件时不能阻塞 HTTP。
- 失败必须可恢复、可解释。
- 成本和吞吐要可控。

## 14. Observability 与成本治理

### 14.1 Trace

每次 ask 记录：

```text
request_id
tenant_id
user_id
library_id
query_type
rewrite
retrieval_plan
dense_latency
bm25_latency
rerank_latency
llm_latency
total_latency
token_usage
model
refused
top_citations
```

### 14.2 Dashboard

最少需要：

- P50 / P95 latency
- ask success / refusal rate
- retrieval no-hit rate
- parser failure rate
- embedding cost
- chat cost
- top failing documents
- user negative feedback samples

设计原因：

- RAG 的线上问题通常不是一个 bug，而是数据、检索、模型、权限、成本一起作用。
- 没 trace 基本无法排障。

## 15. MeriKnow 分阶段落地路线

### Phase 1：巩固 RAG Core

目标：先把现有 ask 短路径升级为「可分类、可记录、可回归」的最小闭环，而不是先做完整框架化重构。

Phase 1 应刻意保守：

- fact / follow_up：走现有短路径，避免打散已稳定能力。
- summary / table / ambiguous 等非 fact 类型：Phase 1 **只分类 + 记录 `RetrievalPlan`**，执行仍落短路径或 clarify；**不建** summary / compare / table 等子图，也不按类型改变 `top_k` 等执行参数。
- `QueryRouter` 先用规则版，不引入 LLM classifier 作为第一刀。
- `RetrievalPlan` 先作为结构化描述和 debug 字段，不急着拆出复杂 retriever 继承体系。
- eval 小黄金集先跑起来，保证后续每次改 chunk / retrieval / judge 都有回归基线。
- payload / archive 先预埋版本、query、judge 字段，为后续多租户、ACL、LangChain adapters 留接口。

Phase 1 子步骤：

1. [x] `QueryRouter`：规则分类 fact / follow_up / summary / table / ambiguous。
2. [x] `RetrievalPlan`：描述 mode、top_k、hybrid、rerank、filters、reason。
3. [x] Ask graph：写入 `query_type`、`retrieval_plan`、`judge`；fact / follow_up 走现有短路径，其余类型仅分类落盘，执行不拆子图。
4. [x] Archive：保存 `query_type`、`retrieval_plan`、`rewrite`、`rewritten_query`、`judge`；citation 保留逐证据 `document_version_id`。
5. [x] Eval：建立可回归黄金集（当前约 38 条），覆盖 no_hit、weak_match、MD/PDF/DOCX、section/table 隔离与 ingest_http；含内存 Qdrant 检索回归。
6. [x] Payload：预埋 `document_version_id`（无完整 version 表时可用派生 stub），可选预埋默认 `tenant_id` / `workspace_id`。

非阻塞可选（Phase 1 之后，不计入 Phase 1 Done）：

- LangChain adapters：接口稳定后再包装 `MeriKnowHybridRetriever` 和 tools；目标形态可保留，但不阻塞本阶段闭环。

**Phase 1 Done 标准**：

- [x] HTTP schema 兼容：`/v1/ask` 等对外响应不破。
- [x] 黄金集本地可跑：`eval_cases.jsonl` + runner 可在本机执行；当前约 **38** 条，含确定性 embedding + 内存 Qdrant、section/chunk/table 隔离、ingest_http 负例。
- [x] archive 能读出 `query_type` / `judge`（及已写入的 plan 相关 debug）。
- [x] `document_version_id` 无完整 version 表时，可用派生 stub 预埋，不强制先建完整版本模型。

评测边界：当前基线已经能拦截 parser、chunker、Qdrant payload、`RetrievalService`、judge 和路由的基础回归，但不代表线上模型效果验收。外部 embedding、hybrid、rerank、答案忠实度和真实企业语料评测仍属于 Phase 5。

检索指标说明：黄金集里的 retrieval 用例默认按 **Recall@3** 判定（目标片段出现在前 3 条即算命中），并记录 `observed_rank` / MRR；关键 fact/table 样例另设 `max_rank<=2` 收紧名次。不要把 Recall@3 误读成「必须第 1 名」。

Phase 1 hardening：另含少量 `ingest_http` 用例，覆盖正例 upload→ready、扫描件失败可见、unsupported 格式 HTTP 400。

数据库边界：Phase 1 保留启动期自动补列，但补列失败必须让 metadata 初始化失败，禁止静默降级成 `persisted=false`。正式环境仍应在 Phase 3 前引入版本化 migration，并把运行账号的 DDL 权限与应用读写权限分离。

### Phase 2：多粒度索引

目标：提升复杂问题能力。

#### Phase 2A（进行中 / 已落地核心）：Section-level

- [x] 统一 `IndexRecord`（`chunk | section | …`），同 collection + `record_type` 过滤。
- [x] 入库按 `section_path` 聚合生成 section records（确定性 ID；过长分段；无 LLM summary）。
- [x] `RetrievalPlan.filters.record_type` 真正驱动检索：`fact/follow_up→chunk`，`summary/section_lookup→section`。
- [x] QueryRouter 增加规则版 `section_lookup`。
- [x] Ask 图：section 路径复用短链路 + 薄 `citation_check`（`source_chunk_ids`）；archive/debug 可见 `record_type`。
- [x] 黄金集：章节 Recall、fact 不泄漏 section、HTTP 兼容。

#### Phase 2B（进行中）：Table-aware Retrieval

- [x] `record_type: table` IndexRecord（headers/rows/row_range；大表分行组且复制表头；确定性 ID）。
- [x] `RetrievalPlan`：`table → record_type=table`；`compare` 暂仍 chunk；Qdrant 强制过滤。
- [x] 轻量 `TableQueryPlan`（filter / min/max / lookup / count）；不确定则澄清，禁止 LLM 心算。
- [x] Ask 图 table 分支：`build_table_plan → table_retrieve → table_execute → judge → generate`。
- [x] Citation / archive 暴露 table_id、row range、TableQueryPlan + execution。

#### Phase 2C：MinerU 复杂文档解析（进行中）

- [x] `DocumentParserBackend`；PyMuPDF 默认，MinerU 补充扫描/复杂 PDF。
- [x] MinerU `content_list` → DocumentIR（page/heading/table/figure/bbox/reading_order）。
- [x] 独立服务客户端：timeout / retry / degrade；`parser_report` 含 backend/version/mode/latency。
- [x] FakeMinerU + 单测；真实服务经 `MINERU_URL`。
- [ ] 更丰富的双栏/跨页表真实 PDF 金标（当前以 JSON fixture + leave-scanned Fake 路径为主）。

#### Phase 2C+（后续）

- 增加 document summary index。
- UI citation 支持版本、章节、表格定位。
- 在业务接口稳定后，引入 LangChain Retriever / Tool 适配层，复用已验证的 `RetrievalPlan`。

#### Phase 2D：分块策略路由（已落地骨架）

- [x] `ChunkingProfile` + versioned policy；支持 `precise / balanced / narrative / table_heavy`。
- [x] 结构优先决策：heading/page/table/code → recursive → char window fallback。
- [x] 可选 semantic：仅处理长、无结构叙事文本；默认关闭，embedding 异常显式降级。
- [x] chunk、Qdrant payload 和 `parser_report.metrics.chunking` 暴露 profile、strategy、reason、fallback。
- [x] `table_heavy` 驱动 table IndexRecord 行组大小，不停留在分类标签。
- [ ] 用真实合同、长报告和表格集做 profile A/B，证明收益后再考虑默认开启 semantic。

详细决策见 `docs/adr/0003-policy-driven-chunking.md`。

### Phase 3：企业权限与租户

目标：从单工作区产品变为 SaaS 架构。

- 引入 tenant / workspace / user / group。
- 所有 library / document / turn 加 tenant_id。
- Qdrant payload 加 tenant_id / workspace_id / ACL scope。
- API dependency 注入 current user / tenant context。
- 检索强制权限 filter。
- 引入版本化数据库 migration；部署阶段执行 DDL，应用运行账号不持有 ALTER 权限。

### Phase 4：生产级任务系统

目标：让 ingestion 可恢复、可观测。

- 完整 ingest_jobs 表。
- Worker 状态机。
- 幂等索引。
- 失败重试和 dead letter。
- UI 展示 parser_report 和 job progress。

### Phase 5：完整评测平台

目标：让优化可量化。

- `eval_cases` 数据格式固定。
- CLI：运行 ingestion eval、retrieval eval、answer eval。
- 增加真实 embedding / hybrid / rerank 的受控集成评测，与确定性 CI 基线分层。
- 指标报告写入 JSON / HTML。
- CI 中跑小型黄金集。
- 后台记录线上反馈，沉淀为 eval case。

## 16. 建议代码落点

优先顺序应服务 Phase 1 闭环：先让 query / plan / judge / eval 进入主链路；LangChain adapters 作为稳定接口之后的包装层，不作为第一刀。

| 模块 | 建议路径 | 职责 |
|---|---|---|
| Query Router | `apps/api/app/services/query_router.py` | query type + rewrite/decompose |
| Retrieval Plan | `apps/api/app/services/retrieval_plan.py` | 描述召回策略 |
| Graph State | `apps/api/app/graph/state.py` | AskState / EvalState / trace schema |
| Graph Nodes | `apps/api/app/graph/nodes/` | query_router / retrieve / rerank / judge / generate |
| Evidence Judge | `apps/api/app/services/evidence.py` | 证据充分性判断 |
| Eval Models | `apps/api/app/eval/schemas.py` | eval case / result schema |
| Eval Runner | `apps/api/app/eval/runner.py` | 批量跑评测 |
| Eval Graph | `apps/api/app/eval/graph.py` | ingestion / retrieval / answer eval 编排 |
| LangChain Adapters | `apps/api/app/langchain_adapters/` | Phase 1 之后 / 非阻塞可选：Document/Retriever/Tool/Output/Callback 适配层；不计入 Phase 1 Done |
| Tool Registry | `apps/api/app/services/tools.py` | Phase 2：LangChain tools 注册和权限包装 |
| Answer Verifier | `apps/api/app/services/answer_verifier.py` | Phase 2：groundedness / citation coverage |
| Tenant Models | `apps/api/app/services/tenancy.py` | tenant/workspace/user context |
| ACL | `apps/api/app/services/acl.py` | permission filter |
| Audit | `apps/api/app/services/audit.py` | audit events |
| Jobs | `apps/api/app/services/ingest/jobs.py` | 扩展为生产状态机 |

## 17. 架构风险

| 风险 | 缓解 |
|---|---|
| 一次性重构过大 | 按 Phase 推进，先 QueryRouter / Eval |
| 多策略导致复杂度上升 | RetrievalPlan 结构化，所有路径可观测 |
| 权限过滤遗漏 | tenant / ACL filter 放到底层 retrieval API，禁止上层绕过 |
| eval 维护成本高 | 从 20-50 个黄金样本开始，随线上反馈增长 |
| OCR / VLM 成本失控 | 默认关闭，按页按需，记录成本 |
| 文档版本破坏历史答案 | 引入 document_version_id，archive 保存引用版本 |

## 18. 判断标准

当 MeriKnow 满足以下条件时，可以更有底气地称为企业级 RAG SaaS：

- 多租户和 ACL 贯穿 API、metadata、vector payload、archive。
- txt / md / docx / pdf / table 至少都有专属解析和 chunk 策略。
- QueryRouter 能按问题类型选择 retrieval plan。
- dense + sparse + rerank + metadata filter 是默认可观测链路。
- 所有回答都有 citation package；证据不足能稳定拒答。
- 有离线 eval、CI 小黄金集、线上反馈回流。
- ingestion 异步、幂等、可重试、可恢复。
- 有 tracing、成本、质量、失败率 dashboard。
- 文档版本和历史问答可复现。

## 19. 下一步

建议立即落地的第一批任务应集中在 Phase 1：先 router / plan / judge / eval，**不**把 LangChain adapters 算进本阶段必做。

1. 新增规则版 `QueryRouter`：分类 fact / follow_up / summary / table / ambiguous；fact / follow_up 走现有短路径，其余类型 Phase 1 只分类 + 记录 `RetrievalPlan`，执行仍落短路径或 clarify。
2. 新增 `RetrievalPlan` schema：记录 mode、top_k、hybrid、rerank、filters、reason，先作为状态和 debug，不急着重写 retriever。
3. 调整 LangGraph ask graph：加入 `query_router -> build_retrieval_plan -> retrieve -> evidence_judge`，保持 HTTP schema 兼容；不建 summary / compare / table 子图。
4. 扩展 archive：记录 `query_type`、`retrieval_plan`、`rewrite`、`judge`，后续再加 `tool_trace`。
5. 建立可回归小黄金集：`eval_cases.jsonl` + runner，Phase 1 先 10–20 条 smoke，覆盖 no_hit、weak_match、MD heading、PDF page、DOCX table。
6. 预埋追踪字段：Qdrant payload / archive 写入 `document_version_id`（无完整 version 表时可用派生 stub），可选写入默认 `tenant_id` / `workspace_id`。

刻意后置（非阻塞，不计入 Phase 1 Done；与 §4.3.10 / §15 / §16 一致）：

- 完整 `langchain_adapters/` 目录、`MeriKnowHybridRetriever` / Tool 包装，以及复杂 Retriever 继承体系。
- 多租户产品化与完整 ACL。
- summary / document-level 索引。
- 完整工具子图和 table / compare agent path。
- 生产级 ingest job 状态机。

**Phase 1 Done 回顾**：HTTP schema 兼容、黄金集本地可跑、archive 可读出 `query_type` / `judge`（及 plan debug）。adapters 完成后置。

这条路径的重点不是堆功能，而是把 RAG 做成工程系统：每一步可解释、可替换、可评测、可治理。
