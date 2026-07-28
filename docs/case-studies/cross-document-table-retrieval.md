# 工程案例：表格问答为什么会选错文档

> 状态：**已通过真实链路复现；字段覆盖安全门已实现，文档级召回绑定待实现**
> 基线：`fc68ed7` · 2026-07-27
> 证据：
> [`Live Retrieval / Ask 质量基线`](../acceptance/reports/2026-07-27-live-retrieval-quality-baseline.md)

## 一句话摘要

UnoRAG 在同一知识库包含多份表格文档时，可能先从错误文档中选出“最像的
可执行表格”，再严格加载并执行它。问题不是跨文档数据被混合，而是缺少可靠的
`问题 → 文档 → 表实例` 两阶段绑定。

这是一个典型的企业 RAG 问题：单文档 demo 正确，不代表多文档知识库中的
检索、结构化执行和拒答边界可靠。

## 背景

测试知识库同时包含：

| 文档 | 内容 | 解析结果 |
|---|---|---|
| `quote-big-80rows.docx` | 85 行设备报价表 | `python-docx` 完整表格结构 |
| `crosstable-large.pdf` | 75 条政府采购项目跨页表格 | PyMuPDF partial；MinerU 未配置 |
| `mixed-charts.pdf` | 饼图、柱状图和说明文本 | PyMuPDF partial；MinerU 未配置 |

测试问题：

> 序号 25 的项目名称、采购单位和中标供应商分别是什么？

期望命中 `crosstable-large.pdf`；实际命中
`quote-big-80rows.docx`，并返回“序号 25 是边缘计算网关”。

这不是偶发生成偏差：`crosstable-large.pdf` 的 4 条问题全部未召回目标文档。

## 影响

- 用户得到格式完整但来自错误文档的答案，比明确拒答更危险。
- 表格执行 trace 全绿，容易让运维误以为结果可信。
- 同库文档越多、schema 越相似，误选概率越高。
- Recall、MRR、引用质量和最终答案正确率会同时下降。
- 单租户/ACL 隔离仍然有效，但同一授权知识库内的来源正确性不可靠。

## 真实证据

本轮使用真实控制面上传、lifecycle worker、PostgreSQL、Qdrant、live embedding
与 `qwen-plus`，不是 stub：

| 指标 | 基线 |
|---|---:|
| 目标文档 Recall@K | `24/29`（82.8%） |
| 文档级 MRR | `0.793` |
| 跨文档引用率 | `46/124`（37.1%） |
| 人工问题级正确率 | `23/29`（79.3%） |

代表 trace：

- `95d06bdd-ca37-4dfa-911f-c5fda79359b3`
- `ce0aa886-5070-475c-803c-70d13f3cc6b4`
- `e19d3d79-f3df-4e72-a033-2623edb9d0f3`
- `dc88697f-adcd-4a47-9b80-14280cf00fe0`

日志显示系统进入 `precise_table`，检索到错误表实例，然后出现：

- `table_load complete=true`
- `table_execute matched_count=0`
- 或 `table_unclear`

因此问题发生在执行前的候选选择，而不是整表加载过程。

## 先排除一个错误猜测

### 猜测：不同文档都有 `table_id=t1`，数据被合并了

该猜测不成立。

表实例在代码中使用复合键：

```text
(doc_id, document_version_id, table_id)
```

整表加载也同时过滤：

```text
library_id
+ doc_id
+ document_version_id
+ table_id
+ active generation
+ ACL scope
```

因此两个文档都叫 `t1` 不会导致行数据合并。实际情况是：

```text
正确目标：(crosstable-doc, version-x, t1)
实际选择：(quote-doc, version-y, t1)
```

系统严格加载了一个身份完整、但业务上选错的表实例。

## 根因链

### 1. 目标文档没有形成可竞争的结构化候选

`crosstable-large.pdf` 和 `mixed-charts.pdf` 在 MinerU 未配置时由 PyMuPDF
降级解析，parser report 为 `partial=true`。

普通文本可能仍可检索，但跨页表格和图表不一定生成完整的：

- `record_type=table`
- `record_type=table_summary`
- headers / rows
- table caption
- image/chart 结构

当问题被路由到 `precise_table` 后，检索只看表格记录。目标文档如果没有表格
记录，就无法进入候选集合。

### 2. 表格检索只有 library scope，没有 document scope

当前 table 路径在整个知识库内分别搜索：

```text
record_type=table
record_type=table_summary
```

在这一步之前，没有先确定“问题最可能属于哪份文档”。

### 3. 无关表格仍可获得中等语义分

采购表和报价表都含有“序号、项目/设备、金额、采购/报价”等通用词。
错误表格仍获得约 `0.52–0.55` 的分数。

### 4. 候选排序无法弥补候选缺失

现有排序会考虑：

1. 行记录优先于 summary；
2. 表头与问题的 schema fit；
3. 向量分数。

该机制能在两张都已正确解析的表之间消歧，但如果目标表根本不在候选池，
排序只能选出“错误候选中最像的一个”。

### 5. 缺少执行前的来源置信门

错误候选被选中后，系统没有再判断：

- 文档语义是否与问题主题一致；
- parser 是否 partial；
- 问题需要的列是否完整存在；
- 第一、第二候选是否存在足够分差；
- “图3/饼图”是否根本不该进入普通 table executor。

本案例还暴露了一个更具体的实现缺陷：TableQueryPlan 会把未解析到的
`select_columns` 静默删除。问题明确要求“项目名称、采购单位、中标供应商”，
但报价表只要能解析“序号”和某个名称列，计划仍可能保持
`confident=true` 并执行。换言之，schema fit 只参与排序，没有成为执行门。

## 当前链路

```text
问题
  → 路由为 precise_table
  → 全知识库检索 table / table_summary
  → 排序并选择一个表实例
  → 按 doc_id + version + table_id 加载整表
  → 代码执行 filter / lookup / min / max
  → 生成答案或 table_unclear
```

问题集中在第二、三步之间：缺少文档级候选和可靠绑定。

## 修复设计

### 阶段 A：记录文档结构化能力

每个 active document version 应暴露可检索能力：

```json
{
  "parse_status": "complete | partial",
  "has_text": true,
  "has_tables": false,
  "has_images": true,
  "table_count": 0,
  "parser_backend": "pymupdf"
}
```

路由不应把“存在 PDF”误当成“存在可执行表格”。

### 阶段 B：先做文档级召回

先用 chunk、section、table summary、标题、文件名和 caption 形成文档候选：

```text
question
  → document candidates
  → document confidence / capability gate
```

文档级评分至少考虑：

- 最佳 chunk/section/table summary 分数；
- 文件名、标题、章节和 caption；
- 问题所需 schema 与文档 headers 的契合度；
- parser 是否 partial；
- 是否具备 table/image 能力。

### 阶段 C：在选定文档内检索表

选定文档后，将现有支持的过滤器写入 retrieval plan：

```json
{
  "record_type": "table",
  "doc_id": "selected-document-id",
  "document_version_id": "active-version-id"
}
```

然后才执行表实例排序和整表加载。

现有 Qdrant loader 已支持该复合绑定，主要改动在候选规划和门禁，不需要重写
整表存储。

### 阶段 D：来源不可信时 fail closed

满足任一条件时不得 best-effort 执行其他文档的表：

- 没有具备 table 能力的高置信目标文档；
- schema 无法覆盖问题要求；
- 第一、第二文档候选分差不足；
- 目标文档为 partial 且缺少结构化表记录；
- 问题是 image/chart，但只有普通 table 候选。

允许的结果只有：

1. 回退到目标文档的普通文本回答；
2. 返回 `refused=true / table_not_available`；
3. 请求用户明确文档或补充 OCR/解析能力。

#### 已实现：显式字段覆盖门

TableQueryPlan 现在区分两类列：

- 用于答案展示的通用候选列：允许缺省；
- 用户明确点名的业务字段：必须由候选表真实覆盖。

对“序号 25 的项目名称、采购单位和中标供应商分别是什么？”：

```text
报价表 headers:
序号 / 设备名称 / 数量 / 单价 / 合计
  → required_columns_unresolved:
    项目名称,采购单位,中标供应商
  → confident=false
  → table_unclear（拒答）

采购表 headers:
序号 / 项目名称 / 采购单位 / 中标供应商 / 中标金额
  → required columns 全部解析
  → confident=true
  → 允许执行
```

严格匹配不会使用“名称”“单位”等宽泛别名，因此“项目名称”不会再被
“设备名称”冒充，“采购单位”也不会误配到计量单位。数值度量仍保留已有的
受控兼容映射，避免破坏“中标金额/总价”等既有问法。

这一步解决的是安全性：

- 正确表在候选池且分数稍低时，可凭完整 schema 反胜；
- 目标表不在候选池时，错误表不能再代答。

它还没有解决可用性：目标扫描 PDF 未生成结构化候选时，系统会安全拒答，
但仍不能给出正确答案。阶段 A–C 的解析能力记录和文档级召回绑定仍需继续。

### 阶段 E：图表意图独立处理

“图3、饼图、柱状图、趋势图”等问题不能仅因为包含数值和聚合词就进入
`precise_table`。

路由至少需要区分：

```text
text fact
structured table
image/chart
```

没有 image/chart 证据时应明确能力不足，而不是拿另一份数据表替代。

## 必须添加的回归测试

1. 同库两份文档都包含 `table_id=t1`，询问各自内容时必须命中正确文档。
2. 目标 PDF 为 partial、另一个 DOCX 有完整表格时，不得用 DOCX 替代目标。
3. 指定文件名、标题或章节的问题必须形成 `doc_id` filter。
4. `图3/饼图/柱状图` 不得错误进入普通 table executor。
5. schema 缺列时返回明确拒答，不能执行最相似的错误表。
6. 候选置信差不足时 clarify/refuse，而不是 best effort。
7. 修复后重跑 33 条正样本和 5 条负样本。

## 完成标准

| 指标 | 当前 | 目标 |
|---|---:|---:|
| 目标文档 Recall@6 | 82.8% | ≥95% |
| 文档级 MRR | 0.793 | ≥0.90 |
| 跨文档引用率 | 37.1% | ≤15% |
| 人工问题级正确率 | 79.3% | ≥85% |
| 跨页表格 4 条目标文档命中 | 0/4 | 4/4 |
| 图表错进报价表 | 1 条 | 0 条 |

修复不能只让单条案例变绿；必须同时改善 Recall、MRR 和跨文档引用率。

## 实施记录

### 2026-07-27：第一阶段安全门

- 新增显式 `required_columns` 提取和严格表头解析；
- 缺少明确请求字段时将计划降为 `fallback`，精确表格链路 fail closed；
- 新增“错误表独占候选时拒答”回归；
- 新增“正确表分数更低但 schema 完整时反胜”回归；
- API 全量测试：`310 passed, 8 skipped`。

待完成：

- 文档级候选生成与 `doc_id + document_version_id` 检索绑定；
- partial PDF / 缺 table capability 的明确错误码与 UI 提示；
- 图表意图独立路由；
- 使用原 33 条正样本和 5 条负样本做真实链路复测。

以下内容在完整修复并完成真实链路复测后填写：

| 项目 | 值 |
|---|---|
| 修复提交 | 待填写 |
| 新增回归测试 | 待填写 |
| 修复后 live 报告 | 待填写 |
| Recall@6 前后对比 | `82.8% → 待填写` |
| MRR 前后对比 | `0.793 → 待填写` |
| 跨文档引用率前后对比 | `37.1% → 待填写` |
| 最终状态 | 待修复 |

## 面试时的 90 秒叙述

> 我在一个企业 RAG 项目里没有停留在单条 Ask smoke，而是建立了包含长合同、
> 大表、跨页 PDF、图表和负样本的真实评测集。结果显示总体文档 Recall@K
> 只有 82.8%，其中一份 75 行采购表的四个问题全部命中了另一份 85 行报价表。
>
> 我最初怀疑两个文档都叫 `table_id=t1` 导致数据串表，但代码和 trace 证明表
> 实例实际由 `doc_id + version + table_id` 隔离，整表加载没有混数据。真正
> 原因是目标 PDF 在没有 MinerU 时只有 partial 文本，没有形成结构化 table
> 候选；而 table 路径直接在整个 library 内搜索，缺少 document binding，于是
> 系统正确执行了错误文档的表。
>
> 我的解决方案是把检索改成两阶段：先做文档级召回和能力门禁，再带 `doc_id`
> 过滤检索表实例；候选不可信时 fail closed，而不是 best effort。同时把 chart
> 从 table 路由中分离。最后用 Recall、MRR、跨文档引用率和原始失败集验证，
> 而不是只看一个 demo 是否回答正确。

这段案例重点体现：

- 用真实数据建立质量基线；
- 用 trace 区分检索、加载、执行和生成；
- 主动推翻错误假设；
- 把局部 bug 提炼成架构修复；
- 用指标和回归集定义完成，而不是凭感觉验收。
