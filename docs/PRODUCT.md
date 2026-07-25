# MeriKnow 产品说明

> 状态：现行北极星（2026-07-25）  
> 关联：[架构](./ARCHITECTURE.md) · [路线图](./ROADMAP.md) · [集成（模式 B）](./INTEGRATION.md)

## 一句话

**MeriKnow = 企业有据知识引擎**——可当公司 AI 助手用，也可无缝接到已有助手里补强 RAG。

## 要解决什么问题

企业内部文档多、制度/手册/表格难搜、通用 Chat 会编造。业务要的是：

1. **能核对**：答案带来源引用，弱证据时拒答或澄清。
2. **能治理**：多租户工作区、文库权限、版本与任务可追踪。
3. **能嵌入**：已有助手不必推倒重来，可只接入检索与有据问答能力。

## 目标用户

| 角色 | 场景 |
|------|------|
| 知识/IT 管理员 | 私有化部署、文库与成员、工作区问答旋钮、任务巡检 |
| 业务员工 | 在工作台提问、看引用、追问、主动归档会话 |
| 平台/助手团队 | 已有 Agent/Chat UI，需要稳定的 retrieve/ask 能力（模式 B） |

## 双模式

### 模式 A — 完整助手（产品 UI）

公司**没有**好用的 AI 助手时，直接用 MeriKnow：

| 能力 | 说明 |
|------|------|
| 工作区 | 组织 / 工作区 / 成员角色 / 邀请 |
| 文库 | 上传、替换、重索引、删除；Job 状态可见 |
| 有据问答 | 流式回答、`[n]` 引用、证据片段、拒答 |
| 追问 | 临时会话短记忆 + query rewrite；归档后按 thread 续聊 |
| 归档 | 默认临时；用户主动归档；可从档案续聊 |

入口：`/app/ask` · `/app/libraries` · `/app/archive` · `/app/settings`

### 模式 B — RAG 嵌入（引擎 API）

公司**已有**助手但 RAG 不行时：通过稳定 API（MCP 后置）接入 **retrieve / ask**，**不强迫**使用 MeriKnow UI 或 Agent 运行时。

| 现状 | 说明 |
|------|------|
| 已实现 | 内部 Data Plane：`POST /v1/ask`、`/v1/ask/stream`、`POST /v1/retrieve`；浏览器经 Next BFF；HMAC 内部鉴权 |
| 已实现（MVP） | 对外模式 B：工作区 service key + `POST /api/v1/retrieve` · `/api/v1/ask`（Bearer `mk_svc_…`）；见 [INTEGRATION.md](./INTEGRATION.md) |
| 规划中 | OpenAPI/错误码版本化、MCP、OAuth-for-apps |

模式 B 的产品承诺是「有据检索与问答能力可被调用」，不是「再做一个通用 Agent 框架」。

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

### 不做 / 明确后置

| 项 | 原因 |
|----|------|
| 开放式通用 Agent 工具生态 | 偏离「有据知识」主线；借鉴 SAG/RAG-Anything 能力，不照搬定位 |
| 公网裸暴露 FastAPI `:8000` | 安全边界：仅内网给 Next / worker |
| 立刻拆独立 PyPI 引擎包 | 先把契约与私有化交付做稳 |
| 每轮问答强制入库 | 默认临时；主动归档 |
| 用户画像 / 长期跨会话记忆 | 企业合规与产品边界；会话窗口够用即可 |
| 云 SaaS 计费套餐、跨 region active-active | 首版私有化优先 |
| 全量 antivirus/DLP 产品化、SBOM 流水线 | 运维增强，不挡核心路径 |

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

| 维度 | 标准 |
|------|------|
| 证据 | 答案可点到片段；无命中/弱相关走拒答或澄清 |
| 隔离 | 跨 organization / workspace / ACL 零泄漏（发布熔断） |
| 版本 | 未激活 generation 不可召回；替换失败旧版仍可用 |
| 会话 | 临时不强制落库；归档可续聊且 rewrite 可用 |
| 模式 A | 新用户能完成：上传 → 问答 → 归档 → 续聊 |
| 模式 B | （规划）外部助手仅用 service key 即可 retrieve/ask，无需嵌我们的 UI |
| 交付 | 私有化可装、可升、可备份；试点 go 见 `docs/acceptance/` |

## 非目标表述（避免误解）

- MeriKnow **不是**「再做一个 ChatGPT」。
- MeriKnow **不是**「开放 Agent 平台」。
- MeriKnow **首先是**有据知识引擎；完整助手是模式 A，嵌入是模式 B。
