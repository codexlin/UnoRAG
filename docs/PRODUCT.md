# UnoRAG 产品说明

> 状态：现行北极星（2026-07-29）
>
> 关联：[产品策略](./STRATEGY.md) · [架构](./ARCHITECTURE.md) · [路线图](./ROADMAP.md) · [集成](./INTEGRATION.md)

## 一句话

**UnoRAG 是一个可私有化部署、权限感知、版本安全、结果可追溯的企业知识服务，为现有业务系统、Agent 和员工知识助手提供 Retrieve 与 Answer 能力。**

产品结构遵循：

> **部署形态独立，使用形态嵌入；运行时 API-first，管理上有控制台。**

## 要解决什么问题

企业内部文档多、制度/手册/表格难搜、通用 Chat 会编造。业务要的是：

1. **能核对**：答案带来源引用，弱证据时拒答或澄清。
2. **能治理**：多租户工作区、文库权限、版本与任务可追踪。
3. **能嵌入**：已有客服、售后、门户、Chat 或 Agent 不必推倒重来，可只接入检索与有据问答能力。
4. **能交付**：可私有化安装、升级、备份、恢复、观测和验收，而不是只在开发机运行。

## 目标用户

| 角色 | 场景 |
|------|------|
| 知识/IT 管理员 | 私有化部署、文库与成员、工作区问答旋钮、任务巡检 |
| 业务员工 | 在工作台提问、看引用、追问、主动归档会话 |
| 平台/助手团队 | 已有业务系统、Agent 或 Chat UI，需要稳定的 retrieve/answer 能力 |

## 一个核心产品，多种使用方式

核心产品是 **UnoRAG Knowledge Service**。它拥有唯一的文档、版本、权限、检索、引用和评测真相。

### 官方 Workspace

公司没有现成知识助手时，可直接使用 UnoRAG Workspace；管理员也通过它管理和验收 Knowledge Service：

| 能力 | 说明 |
|------|------|
| 工作区 | 组织 / 工作区 / 成员角色 / 邀请 |
| 文库 | 上传、替换、重索引、删除；Job 状态可见 |
| 有据问答 | 流式回答、`[n]` 引用、证据片段、拒答 |
| 追问 | 临时会话短记忆 + query rewrite；归档后按 thread 续聊 |
| 归档 | 默认临时；用户主动归档；可从档案续聊 |

入口：`/app/ask` · `/app/libraries` · `/app/archive` · `/app/settings`

### 嵌入现有系统

公司已有客服、售后、门户、Chat 或 Agent 时：通过稳定 API 接入 **retrieve / answer**，不强迫使用 UnoRAG UI 或 Agent 运行时。

| 现状 | 说明 |
|------|------|
| 已实现 | 内部 Data Plane：`POST /v1/ask`、`/v1/ask/stream`、`POST /v1/retrieve`；浏览器经 Next BFF；HMAC 内部鉴权 |
| 已冻结（v1.0） | 工作区 service key + `POST /api/v1/retrieve` · `/api/v1/ask`；契约见 [contracts/retrieve-ask-v1.md](./contracts/retrieve-ask-v1.md) 与 [INTEGRATION.md](./INTEGRATION.md) |
| 近期扩展 | 对外统一产品术语 `answer`；保持 `ask` 兼容期，补齐 Documents/Versions/Jobs 等知识生命周期接口 |
| 已交付（0.1.0） | Python SDK、MCP（薄适配 Retrieve/Ask v1；见 `sdk/python/` · `sdk/mcp/`） |
| 规划中 | 外部 Documents/Versions/Jobs API、OpenAI-compatible adapter |

产品承诺是「企业知识能力可被治理和调用」，不是「再做一个通用 Agent 框架」。

### SDK 与协议适配

Python SDK、MCP 和 OpenAI-compatible endpoint 只做稳定 Knowledge API 的薄适配：

```text
Python SDK ──┐
MCP Server ──┼──► Knowledge API ──► 同一 ACL / active generation / citation
OpenAI API ──┘
```

Python SDK 是 API client，不将数据库、Qdrant 和完整引擎复制进客户业务进程。MCP 首版以只读知识工具为主，OpenAI compatibility 用于降低迁移成本，UnoRAG 原生契约仍是权威。

## 术语

| 术语 | 含义 |
|------|------|
| Knowledge Service | UnoRAG 核心产品整体 |
| Workspace | 官方管理控制台和参考客户端 |
| Library | 当前产品 UI / 内部数据模型中的文库 |
| Knowledge Base | 规划中的对外 API 资源名称；迁移时映射现有 Library，不复制数据 |
| Ask | 当前实现、内部 LangGraph 和兼容 API 使用的名称 |
| Answer | 规划中的对外产品术语；返回生成答案、引用、拒答与 trace |
| Retrieve | 只返回证据包，不替客户决定最终生成流程 |

## 做什么 / 不做什么

### 做（当前与近中期）

- 多租户工作区与成员
- 文库、文档版本、ACL（数据面过滤已落地；产品侧细粒度编辑后置加强）
- 解析入库：DocumentIR → 结构感知切片 → embedding → 分 generation 激活
- 检索：dense；可选 hybrid（BM25+RRF）、rerank；表格路径
- 引用 / 裁决 / 拒答
- 临时会话 + **主动归档** + 可续聊
- 工作区级 ask 旋钮（少配置；不靠一堆 env）
- 受限多步（表格执行等）后置加强，不做开放工具生态
- 稳定 Knowledge API：Documents / Jobs / Retrieve / Answer / Feedback / Trace
- Python SDK、MCP、OpenAI-compatible 薄适配

### 不做 / 明确后置

| 项 | 原因 |
|----|------|
| 开放式通用 Agent 工具生态 | 偏离「有据知识」主线；借鉴 SAG/RAG-Anything 能力，不照搬定位 |
| 公网裸暴露 FastAPI `:8000` | 安全边界：仅内网给 Next / worker |
| 立刻拆独立 PyPI 引擎包 | 先把契约与私有化交付做稳 |
| 每轮问答强制入库 | 默认临时；主动归档 |
| 用户画像 / 长期跨会话记忆 | 企业合规与产品边界；会话窗口够用即可 |
| 云 SaaS 计费套餐、跨 region active-active | 首版私有化优先 |
| 全量 antivirus/DLP 产品化、SBOM 与镜像签名 | Trivy 镜像扫描已交付；其余属于运维与合规增强 |
| OAuth-for-apps | 当前产品非目标；服务间接入使用可审计、可限制 scope 的 Service Key。只有明确建设公网多租户开发者平台时才重新评估 |

## 会话模型（产品合同）

```text
默认临时
  → 进程内短记忆（可追问）
  → 关闭/刷新可能丢失
主动归档
  → 写入 thread + turns（Postgres）
  → 档案列表可打开、可续聊
  → 续聊生成多轮 messages + 检索 query 改写
```

配置原则：**少配置**。检索/问答产品旋钮 = 代码默认 ⊕ 工作区覆盖（见 `apps/api/app/services/ask_defaults.py`），**不要**用已废弃的 `HYBRID_ENABLED` 等 env 当产品开关。

## 与同类定位的关系

| 参照 | 借鉴 | 不照搬 |
|------|------|--------|
| DustyKB 类产品经验 | 工作区、文库、有据体验 | 具体 UI/品牌 |
| QueryNest / 多步编排 | 受限表格与 query route | 通用 Agent 工具市场 |
| SAG / RAG-Anything | 解析、多模态、复杂文档能力 | 「万能 Agent / 万能框架」定位 |

## 成功标准（产品层）

**当前发布口径：私有部署的预发布参考基线已通过。** `webch` 用于模拟真实线上拓扑，
不是正式客户生产环境；其持续 soak 不阻塞代码基线提交。这不表示 UnoRAG 已达到适用于
任意客户和环境的通用生产 GA。每个客户部署仍须完成隔离、安全、容量、恢复和运维责任
验收，结论记录在 `docs/acceptance/`。

| 维度 | 产品标准 | 当前判定 |
|------|----------|----------|
| 证据 | 答案可点到片段；无命中/弱相关走拒答或澄清 | 核心能力已实现；纳入试点验收 |
| 隔离 | 跨 organization / workspace / ACL 零泄漏（发布熔断） | 必须通过目标环境门禁 |
| 版本 | 未激活 generation 不可召回；替换失败旧版仍可用 | 核心能力已实现；纳入回归 |
| 会话 | 临时不强制落库；归档可续聊且 rewrite 可用 | Workspace 主路径可用 |
| Workspace | 新用户能完成：创建/切换工作区 → 上传 → 问答 → 归档 → 续聊 | 主路径可用 |
| Knowledge API | 外部系统无需嵌 UI 即可管理知识生命周期并 retrieve/answer | Service Key + Retrieve/Ask v1.0 契约已冻结；完整生命周期 API 规划中 |
| 接入 | SDK/MCP/OpenAI adapter 不产生第二套权限、版本和检索真相 | Python SDK / MCP 0.1.0 已交付；OpenAI-compatible 仍规划中 |
| 交付 | 私有化可安装、升级、备份和恢复 | 按具体部署完成验收后才可 Conditional GO |

## 非目标表述（避免误解）

- UnoRAG **不是**「再做一个 ChatGPT」。
- UnoRAG **不是**「开放 Agent 平台」。
- UnoRAG **首先是**企业知识服务；Workspace 是官方客户端，API/SDK/MCP/OpenAI adapter 是接入面。
