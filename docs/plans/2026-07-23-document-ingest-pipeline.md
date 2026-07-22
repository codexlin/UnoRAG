# MeriKnow 文档解析与索引管线实施计划

> **For agentic workers:** 建议按阶段推进；每阶段结束应有可测交付。勾选框 `- [ ]` 用于跟踪。  
> **关联：** [bootstrap 总计划](./2026-07-22-meriknow-bootstrap.md) · 现状：`apps/api/app/services/documents.py`（txt/md/pdf 抽字）+ `chunking.py`（固定字数）+ hybrid/rerank ask。  
> **日期：** 2026-07-23

**Goal:** 把「任意办公文档 → 可追溯知识」做成生产级管线：类型分流解析、结构还原、语义切片、双路索引，并预留 Agent 工具化按需阅读。

**Architecture:** 所有格式汇入统一 Document IR；L1 按格式/页类型选解析器，L2 还原结构树，L3 语义切片并补上下文 preamble + metadata，L4（后期）将能力封装为 `search` / `read_section` / `extract_table` / `quote_source`。Ask 路径继续吃 IR 产出的 chunk，不直接啃原文件。

**Tech Stack（目标）:** PyMuPDF ·（可选）OCR · Markdown AST · python-docx · 现有 Qdrant dense + BM25/RRF · Postgres 元数据 · LangGraph ask（后续工具节点）

## Global Constraints

- **诚实失败：** 扫描件无 OCR、空文本、解析失败必须显式 error，禁止静默空库「ready」。
- **可追溯：** 每个对外 citation 至少能定位 `doc_id` +（`page` 或 `section_path`）+ 原文片段；企业场景优先「看见的 ≈ 模型用的」。
- **成本可控：** VLM / OCR 仅打需要的页/块，默认不整本多模态。
- **不 regress：** 现有 txt/md/文本 PDF 上传问答路径在迁移期保持可用（可双写或 feature flag）。
- **非目标本期：** 全量 SSO/ACL、SaaS 计费、一次性做成全能 PDF Agent 平台。

---

## 1. 问题与现状

### 现状（缺口）

| 能力 | 现状 | 问题 |
|------|------|------|
| PDF | PyMuPDF `get_text` + `## Page N` 拼接 | 无类型分流；封面重复字/CID 乱码；扫描件直接失败 |
| 切块 | 固定 500/80 字符 | 跨页跨章；页码取 chunk 内**最后一个** `## Page N` → 标成 p.2 但正文从 Page 1 起 |
| MD/TXT | 当纯文本 | 丢掉 heading/代码/表结构 |
| Word | 不支持 | — |
| 引用 | title/filename/page/snippet/text | 无 section、无表格 id、无 preamble |
| Agent | 单次 retrieve→generate | 无按页/按表工具 |

### 目标一句话

**识别类型 → 多路解析 → 还原结构 → 语义切片 + chunk 上下文 → dense+关键词双路索引 →（后期）工具化按需读 → 页/章引用 + 测评闭环。**

---

## 2. 目标架构：四层 + 统一 IR

```text
Upload
  │
  ▼
┌─────────────────────────────────────────────┐
│ L1 Parse Router                             │
│  detect(format, page signals) → parser(s)   │
│  txt | md | docx | pdf-text | pdf-ocr | vlm │
└───────────────────┬─────────────────────────┘
                    ▼
┌─────────────────────────────────────────────┐
│ L2 Structure Restore → Document IR          │
│  headings / paras / tables / figures / …    │
│  strip headers/footers when confident       │
└───────────────────┬─────────────────────────┘
                    ▼
┌─────────────────────────────────────────────┐
│ L3 Semantic Chunk + Index                   │
│  structure-aware split + preamble           │
│  metadata → Qdrant payload + BM25 corpus    │
└───────────────────┬─────────────────────────┘
                    ▼
┌─────────────────────────────────────────────┐
│ L4 Agent Tools (Phase D+)                   │
│  search_docs · read_section · extract_table │
│  quote_source · (read_page for PDF)         │
└─────────────────────────────────────────────┘
```

### 2.1 Document IR（所有格式汇入）

逻辑模型（实现可用 Pydantic；持久化可先 JSONB / 后独立表）：

```text
Document
  id, library_id, source, source_format, content_hash, version, parser_report

Node
  id, type: heading|paragraph|list|table|code|figure|footnote|slide|…
  path: "3.2" | "第3章/第2条" | null
  level: int | null          # heading level
  page_start, page_end       # PDF/PPT；MD/TXT 可空
  text | table_json | figure_desc
  bbox? / confidence

Chunk
  chunk_index
  text                       # 送入 embedding / LLM 的正文（可含 preamble）
  body                       # 不含 preamble 的原文（引用展示优先用这个）
  preamble                   # 「本文属于…第x章…」
  metadata:
    doc_id, library_id, title, filename
    section_path, heading_text
    page_start, page_end, page_label
    node_ids[], table_id?, figure_id?
    source_format, content_hash
```

**Preamble 约定（Anthropic 思路）：** 每个 chunk 前补 1～3 句定位说明，例如：

> 文档《员工手册》· 第3章 考勤 · 第12条 · 第5页  

embedding 可用 `preamble + body`；抽屉引用默认展示 `body`，并单独展示定位条。

### 2.2 L1 — 解析层

| 信号 | 判定倾向 | 解析器 |
|------|----------|--------|
| `.txt` | 文本 | 编码探测 + 规范化 |
| `.md` / `.markdown` | 结构化文本 | Markdown AST |
| `.docx` | 结构化办公 | python-docx / 等效 |
| PDF 页文字密度高、图片少 | 原生文本 PDF | PyMuPDF / 等价 |
| PDF 页几乎无字、大图 | 扫描件 | OCR（Paddle/系统 OCR，选型单独立项） |
| PDF 页有复杂表/流程图/截图 | 视觉复杂页 | 文本抽表优先，失败再 VLM 摘要 |
| `.xlsx` / `.csv` | 表优先 | 表解析（后期） |
| `.pptx` | 页=幻灯 | 按 slide 抽字（后期） |

**硬规则：**

- 页级（或文件级）写出 `parser_report`：`text_pages` / `ocr_pages` / `vlm_pages` / `failed_pages`。
- 整本无任何可抽取内容 → 文档 `status=failed` + 可读错误（已有扫描件失败语义，需保留并扩展）。

### 2.3 L2 — 结构还原

- **MD/DOCX：** 信任原生 heading/styles；列表、表、代码、图片说明入库为节点。
- **TXT：** 空行分段；可选启发式标题（短行、编号行）；`confidence=low`。
- **PDF：** best-effort：去页眉页脚（重复顶底行）、按字体大小/位置猜标题、表区域检测；失败则退回「页 → 段落」。
- **场景标签（可选 metadata）：** `contract` / `report` / `resume` / `thesis`… 仅影响切片提示与测评集，不阻塞通用路径。

### 2.4 L3 — 切片与索引

**禁止作为唯一策略：** 固定字符窗跨章硬切（现状）。允许作为「无结构节点」的 fallback，且必须记录 `split_strategy=char_window`。

**优先策略：**

1. 按 heading 子树 / 条款节点切；超长节点再在节点内二次切（保留同一 `section_path`）。
2. 表格：独立 chunk（或行组 chunk）+ `table_id` + 字段文本化。
3. 图片/图：caption +（可选）VLM 摘要进 chunk；原图引用后期再做。
4. 每个 chunk 必带 metadata（上表）；写入 Qdrant payload；BM25 语料与 dense 同源 `body`（或 `preamble+body`，需测评二选一，默认 `preamble+body` 检索、`body` 展示）。

**双路索引：** 保持并强化现有 hybrid（dense + BM25 + RRF）+ 可选 rerank；payload 过滤 `library_id`（已强制）+ 后续 `section_path` / `doc_id`。

### 2.5 L4 — Agent 工具（后期）

| 工具 | 职责 | 何时用 |
|------|------|--------|
| `search_docs` | 向量+关键词检索 | 简单事实 |
| `read_section` | 按 section_path / node 读全文 | 需要完整条款 |
| `read_page` | PDF/PPT 按页 | 用户点名页码 |
| `extract_table` | 返回结构化表 | 指标/对比 |
| `quote_source` | 规范 citation 包 | 生成前强制引用 |

简单问句可继续走「单次 retrieve → judge → generate」；复杂对比再上规划多步工具（LangGraph）。

---

## 3. 分格式处理策略（汇总）

| 格式 | L1 | L2 | L3 要点 | 引用定位 |
|------|----|----|---------|----------|
| TXT | 编码探测 | 段落 | 段落合并；fallback 字窗 | `para_id` / 行号 |
| MD | AST | 标题树 | **按 heading 切**；代码整块；表独立 | `section_path` |
| DOCX | styles/表/图 | Heading 样式树 | 同 MD | `section_path` |
| PDF | 页分类多路 | 页+章 best-effort | 页边界优先；章内语义切 | `page_start–end` + path |
| xlsx/csv | 表解析 | sheet/表 | 行组/字段；少整表 embed | `sheet!A1:B10` |
| pptx | 按 slide | slide≈页 | 一页多 chunk | `slide N` |

**原则：** 结构化格式信样式；弱结构保边界；视觉格式分流且贵模型按需；表格数据结构化优先于纯向量。

---

## 4. 与当前代码的落点（文件地图）

| 单元 | 路径（目标） | 职责 |
|------|----------------|------|
| 解析路由 | `app/services/ingest/router.py` | 扩展名 + PDF 页信号 → parser |
| 各 parser | `app/services/ingest/parsers/{txt,md,docx,pdf}.py` | bytes → IR（或 intermediate blocks） |
| IR 模型 | `app/services/ingest/ir.py` | Document/Node/Chunk schemas |
| 结构/切片 | `app/services/ingest/structure.py`, `chunker.py` | L2/L3；替换/包裹现有 `chunking.py` |
| 文档入口 | `app/services/documents.py` | 薄封装，保留 `clean_display_title` 等 |
| 入库 | `app/services/retrieval.py` `ingest_*` | IR chunks → embed → Qdrant；写 parser_report |
| 引用 | `app/schemas.py` `Citation` | 增 `section_path`, `page_start/end`, `preamble?` |
| Ask | `app/graph/ask_graph.py` | 先消费新 metadata；D 期加工具节点 |
| Web | `ask-workspace` / drawer | 展示章/页范围/定位条 |
| 测评 | `apps/api/tests/eval/` 或 `scripts/eval_ingest.py` | 黄金样本 |

迁移期可用 `INGEST_PIPELINE=legacy|v2`（settings）切换。

---

## 5. 分期实施

### Phase A — IR + MD/TXT 黄金路径（先做最稳结构）

**产出：** MD/TXT 经 IR 切片入库；chunk 带 `section_path` + preamble；引用 UI 可显示章节。

- [ ] 定义 `ir.py`（Document/Node/Chunk）与序列化
- [ ] MD parser（heading/list/code/table）→ IR
- [ ] TXT parser（编码 + 段落）→ IR
- [ ] 结构感知 chunker + preamble；legacy char_window 仅作 fallback
- [ ] `ingest` 写 Qdrant payload 新字段（向后兼容旧 payload）
- [ ] Citation / 抽屉展示 `section_path`；无则隐藏
- [ ] 单测：样例 `fixtures/handbook.md` 切片不跨 H2；preamble 非空
- [ ] `INGEST_PIPELINE=v2` 对 md/txt 默认开；pdf 暂走 legacy

**验收：** 上传 MD 制度文档，问答引用出现「第 x 章」类路径；固定字数跨章切显著减少。

### Phase B — PDF 页级分流与按页/结构切

**产出：** 文本 PDF 页分类；按页（再章内）切片；页码为范围而非「最后一个 Page 标记」。

- [ ] PDF 页信号：文字字符数、图片占比 → `text | suspect_scan | complex`
- [ ] 文本页：抽取 + 去重复行/页眉页脚启发式
- [ ] 扫描页：显式 `needs_ocr`；无 OCR 时该页失败计入 report，整本策略可配置（`fail` / `partial`）
- [ ] chunk `page_start`/`page_end`；`infer_page_label` 改为范围或主页面
- [ ] 复杂页占位：先抽得到的字 + `vlm_pending` 标记（VLM 放到 Phase C）
- [ ] 回归：人事库简历/毕业设计类 PDF 封面重复字清洗；引用页码与正文一致

**验收：** 抽屉不再出现「标 p.2 但大段 ## Page 1」的系统性错误；扫描件失败原因可读。

### Phase C — DOCX + 表格节点 +（可选）OCR/VLM

**产出：** Word 入库；表格独立 chunk；可选 OCR/VLM 接入。

- [ ] DOCX parser → IR（Heading/表/图 caption）
- [ ] 表格 → `table_json` + 文本化行；`extract` 路径预备
- [ ] OCR 适配器接口 + 一种默认实现（选型写入 ADR 小节）
- [ ] VLM 适配器：仅 `complex` 页/图；摘要写入 figure/table 节点
- [ ] Web 上传 accept 扩展；文库说明文案更新
- [ ] 测评集 v0：MD 条款定位、PDF 页命中、表字段（有表样本时）

**验收：** docx 制度可问条款；表类问题引用带 `table_id` 或可定位单元格说明。

### Phase D — Agent 工具链路 + 测评闭环

**产出：** LangGraph 可选工具节点；评测脚本；引用与命中指标。

- [ ] 工具：`search_docs` / `read_section` / `read_page` / `extract_table` / `quote_source`
- [ ] 路由策略：简单事实短路径；多跳/对比走工具；表/图走专用工具
- [ ] 多维测评：检索命中、页/章准确、表解析、OCR 漏字率、图表摘要正确率（有样本才计）
- [ ] 档案/审计保留 `parser_report` + retrieval 快照（承接已有 persist 可见性）
- [ ] 文档：README / API README 更新管线说明；bootstrap Phase 3 OCR 条目标记衔接

**验收：** 复杂问题可展示工具轨迹（debug）；黄金集基线可重复跑。

---

## 6. 成功标准（总）

- 格式：txt / md / docx / 文本 PDF 生产可用；扫描 PDF 有明确 OCR 路径或失败原因。
- 切片：默认按结构；chunk 含 preamble + section/page metadata。
- 索引：dense + BM25 双路（已有）吃新 chunk；library 隔离保持。
- 引用：答案可带页码和/或章节 + 原文 body；抽屉全文与模型上下文一致策略保持。
- 测评：至少 MD+PDF 各 1 套黄金问答可自动打分（命中与定位）。
- 成本：默认路径无全量 VLM；health/配置可关闭 OCR/VLM。

---

## 7. 风险与决策

| 风险 | 缓解 |
|------|------|
| PDF 结构还原过拟合 | L2 best-effort + confidence；失败降级页级段落 |
| OCR/VLM 成本与延迟 | 页级路由；异步索引队列（与企业壳 Phase 对齐） |
| IR 迁移打爆旧向量 | `content_hash` 变化才重嵌；`INGEST_PIPELINE` 开关；文档级 reindex API |
| 范围膨胀 | 严格按 A→B→C→D；xlsx/ppt 不进 A–C 除非业务强需求 |
| 隐私 | 简历等 PII 片段照常可检索；ACL 仍归企业壳，本管线只保证库级隔离 |

**已拍板倾向（可在实现前复核）：**

1. embedding 用 `preamble + body`，UI 引用主展示 `body`。  
2. PDF 无 OCR 时允许 `partial` 入库（仅成功页），但 UI 必须提示「部分页未解析」。  
3. L4 不阻塞 A–C；ask 短路径始终保留。

---

## 8. 建议执行顺序（给执行者）

1. 先落地 **Phase A**（IR + MD/TXT）——收益最大、风险最低，并成为其他格式模板。  
2. 再 **Phase B**（PDF 页码/分流）——直接修复当前人事库痛点。  
3. **Phase C** 按客户文档构成选 DOCX vs OCR 优先级。  
4. **Phase D** 与 bootstrap「企业壳 / 评测」一起做。

---

## 9. 参考

- 现状实现：`documents.py` · `chunking.py` · `retrieval.py` · `ask_graph.py`
- 产品约束：诚实失败、强制 `library_id`、hybrid/rerank 降级可见（已落地）
- 外部思路：Anthropic PDF / chunk 上下文补全；Claude「不只读字、理解视觉」→ 对应本计划 VLM 分支（按需）
