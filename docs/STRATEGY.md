# MeriKnow 产品策略

> 状态：现行方向（2026-07-26）
>
> 产品边界见 [PRODUCT.md](./PRODUCT.md)，工程实现见 [ARCHITECTURE.md](./ARCHITECTURE.md)，执行顺序见 [ROADMAP.md](./ROADMAP.md)。

## 核心判断

企业 RAG 既可能以完整知识助手出现，也可能只是客服、售后、门户或 Agent 中的一项能力。MeriKnow 不在二者之间二选一，而采用统一结构：

> **部署形态独立，使用形态嵌入；运行时 API-first，管理上有控制台。**

MeriKnow 独立负责知识的接入、版本、权限、检索、回答、证据、评测和运维；最终用户可以使用官方 Workspace，也可以继续使用客户已有业务系统。

## 产品定位

### 一句话

**MeriKnow 是一个可私有化部署、权限感知、版本安全、结果可追溯的企业知识服务，为现有业务系统、Agent 和员工知识助手提供 Retrieve 与 Answer 能力。**

英文表述：

> A deployable, permission-aware and evidence-grounded knowledge service for enterprise applications and agents.

### 不用什么表述

- 不把 MeriKnow 定位成「通用 Agent 平台」。
- 不把 MeriKnow 定位成「另一个 ChatGPT」。
- 不把 MeriKnow 定位成「带 UI 的向量数据库」。
- 不把 MeriKnow 定位成需要嵌入业务进程的 Python RAG 框架。
- 不以模型、LangGraph 或 Qdrant 作为客户价值主张。

客户购买的不是 RAG 技术名词，而是可核对的回答、权限隔离、文档更新安全、失败可追踪和可交付的私有化能力。

## 产品层级

```text
┌────────────────────────────────────────────┐
│ 官方客户端                                 │
│ Workspace：管理、问答、归档、调试、验收    │
├────────────────────────────────────────────┤
│ 接入适配                                   │
│ Python SDK / MCP / OpenAI-compatible       │
├────────────────────────────────────────────┤
│ 稳定 Knowledge API                         │
│ Documents / Jobs / Retrieve / Answer       │
├────────────────────────────────────────────┤
│ 企业知识内核                               │
│ ACL / Version / Parse / Index / Eval       │
└────────────────────────────────────────────┘
```

### 企业知识内核

这是产品最重要的不可替代部分：

- document / version / generation / job 生命周期
- staging 后激活，替换失败时旧 active 继续服务
- tenant / workspace / principal / group ACL
- DocumentIR / TableIR 与结构感知切分
- dense、hybrid、rerank 与受限表格执行
- citation、裁决、拒答
- trace、评测、发布门禁、备份恢复与私有化运行

### 稳定 Knowledge API

API 是核心产品契约，而不是 Workspace 的附属接口。目标资源面：

```text
Knowledge Bases
Documents / Versions / Jobs
Retrieve
Answer / Answer Stream
Feedback
Trace Debug
```

`Retrieve` 与 `Answer` 必须同时存在：

- 客户只需要证据包时调用 Retrieve，自行完成 Agent 编排和生成。
- 客户需要开箱即用的有据回答时调用 Answer。
- 两者共享相同 active generation、ACL、引用和可观测内核。

### 官方 Workspace

Workspace 有三重职责：

1. 可直接使用的企业知识助手。
2. 文库、成员、ACL、任务、设置、审计的管理控制台。
3. 展示和验收 Knowledge API 的参考客户端。

Workspace 很重要，但不得反向绑死 Knowledge API，也不得让路线图退化为单纯优化 Chat 页面。

### SDK 与协议适配

所有适配层只调用稳定 HTTP API，不拥有第二套检索、权限或版本真相：

```text
Python SDK ──┐
MCP Server ──┼──► MeriKnow Knowledge API
OpenAI API ──┘
```

- Python SDK 是 API client，不把 PostgreSQL、Qdrant 和完整引擎嵌入客户 Python 进程。
- MCP 首版只提供只读知识工具，例如 `search_knowledge`、`answer_with_sources`、`get_source`。
- OpenAI-compatible endpoint 用于降低迁移成本；MeriKnow 原生 citation、refusal、trace schema 仍是权威契约。

## 目标客户与首发场景

### 首要买方

- 需要私有化部署的中小型企业 IT / AI 平台团队
- 已有 Chat、Agent、客服或门户，但缺少可靠知识层的产品团队
- 有文档权限、版本更新、引用和审计要求的知识管理团队

### 首要用户

- 客服与售后工程师
- 解决方案与交付团队
- 内部员工
- 构建企业 Agent 的开发者
- 管理文库与权限的 IT / 知识管理员

### 推荐商业切入口

技术内核保持横向，首发销售场景保持具体。优先验证：

1. **产品与售后知识服务**：产品手册、安装说明、故障 SOP、参数表、报价表、历史解决方案。
2. **内部制度与流程助手**：HR、财务、差旅、信息安全、合规制度。

面试和公开演示可使用制度、合同与报价表；真实商业验证优先寻找售后、客服、技术文档等错误回答成本更高的场景。

## 交付与商业化路径

### 阶段 1：可信开源产品

目标交付包括可重复运行的 Compose、Workspace、Retrieve/Ask 对外 API v1.0、示例数据、质量门禁、基础运维文档和可复现演示。

Python SDK、MCP 和 OpenAI-compatible adapter 不属于本阶段必交付；它们应在 Knowledge API 经真实集成验证稳定后，作为降低接入成本的薄适配层提供。具体顺序以 [ROADMAP.md](./ROADMAP.md) 为准。

目标不是堆 star，而是证明：

- 新用户能完成上传、问答、引用、归档和 API 接入。
- 文档替换、失败、删除和权限变化行为可验证。
- 部署、升级、恢复和故障定位有明确操作路径。

### 阶段 2：收费试点与实施

个人项目最现实的第一笔收入通常来自：

- 私有化部署
- 客户模型和身份系统对接
- 文档迁移与 Connector
- 评测集建设
- 试点验收
- 运维和升级支持

先通过服务带产品获取真实约束，再把重复交付内容产品化。

### 阶段 3：企业增强

可形成商业价值的能力包括：

- OIDC / SSO、LDAP 和组织同步
- SharePoint、网盘、Wiki 增量 Connector
- 高可用、监控告警、备份恢复
- 细粒度 ACL 和审计
- 数据保留、合规交付与支持 SLA

公网多租户 SaaS、复杂计费和多 region 不作为当前前置条件。

## 面试叙事

面试展示重点不是技术名词数量，而是工程决策：

- 为什么拆 Control Plane / Data Plane
- 为什么 `app.jobs` 是唯一任务事实源
- 为什么索引必须 staging 后激活
- 如何保证新旧版本不混合
- 如何防止 tenant / workspace / ACL 泄漏
- 为什么表格精确问题不能让 LLM 猜
- 模型、Qdrant、Worker 失败时系统如何退化和恢复
- 外部系统如何通过稳定契约接入
- 如何用 trace、eval、SLO 和 go/no-go 证明系统可交付

推荐演示主线：

```text
上传旧版 → 带引用回答
→ 上传新版 → 处理中旧版继续服务
→ 新版激活 → 答案切换
→ restricted ACL → viewer 无法召回
→ Service Key 调用 Retrieve/Ask v1.0
→ Trace Drawer 解释一次拒答
```

## 产品纪律

在受控私有化试点达到 Conditional GO 之前，不让以下事项挤占主线：

- 开放式通用 Agent 工具生态
- 多 Agent 编排平台
- 大量低验证 Connector
- 公网 SaaS 计费与套餐
- 长期用户画像与跨会话记忆
- 只为了展示技术而增加新的检索框架

每项新能力都应回答：

1. 它是否增强 Knowledge Service 的可靠性、可接入性或可交付性？
2. 是否有真实场景或评测证明收益？
3. 是否保持唯一权限、版本和检索真相？
