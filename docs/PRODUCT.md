# UnoRAG 产品说明

**UnoRAG 是可私有化部署、权限感知、以证据为中心的企业知识服务。** 它把企业文档转化为
可治理、可检索、可核验的知识能力，既提供面向员工和管理员的 Workspace，也提供可嵌入
现有客服、售后、门户和 Agent 的 Retrieve / Ask API。

当前默认交付是一位客户一套独立实例。Organization 表示部署所属企业，Workspace 用于该企业内部
部门、项目和权限隔离；公网共享多租户 SaaS 不在当前产品范围内。

> 部署形态独立，使用形态嵌入；运行时 API-first，管理上有控制台。

## 为什么存在

企业 RAG 的难点不是“把文本存进向量库”，而是让整个知识生命周期可被信任：

1. **答案可核对**：返回真实来源和版本；证据不足时拒答或澄清。
2. **知识不越权**：身份、Workspace、文库、文档和用户组权限在检索前强制生效。
3. **更新不中断**：新版本独立处理并校验，成功后原子激活，失败继续服务旧版本。
4. **复杂文档可用**：保留页面、标题、表格、单位、行范围和来源坐标，而不是只做固定字符切分。
5. **系统可交付**：安装、升级、备份、恢复、监控和验收都有明确操作边界。

## 面向谁

| 角色 | 主要价值 |
|---|---|
| 企业 IT / AI 平台团队 | 在自有网络、数据库、模型和密钥边界内交付知识服务 |
| 知识管理员 | 管理 Workspace、成员、文库、版本、任务和权限 |
| 业务员工 | 提问、查看引用、追问并归档有价值的会话 |
| 产品与集成团队 | 通过稳定 HTTP API 为现有产品增加有据检索和问答 |

首发场景聚焦错误回答成本高、文档更新频繁、需要来源核对的知识工作：

- 产品手册、安装说明、故障 SOP、参数表、报价表和售后案例；
- HR、财务、差旅、信息安全与合规制度。

## 产品形态

```text
UnoRAG Workspace
  管理 / 问答 / 归档 / 调试 / 验收
             ↓
Knowledge API
  Service Key / Retrieve / Ask
             ↓
Enterprise Knowledge Core
  ACL / Version / Parse / Index / Retrieve / Evaluate
```

Workspace 和 API 使用同一套组织、权限、版本、索引、引用和评测事实，不产生第二套数据模型。

### Workspace

- 创建和切换 Workspace，邀请成员并分配 viewer、editor、admin；
- 创建文库，上传、替换、重索引和删除文档；
- 查看异步 Job 进度、失败原因、重试与取消；
- 流式问答、查看证据、连续追问；
- 主动归档会话，并从历史线程继续；
- 创建带 scope 的 Service Key。

入口：`/app/ask`、`/app/libraries`、`/app/archive`、`/app/settings`。

### Knowledge API

`POST /api/v1/retrieve` 和 `POST /api/v1/ask` 已作为 v1 契约提供。调用方通过 Service Key
进入与 Workspace 相同的授权和检索边界，无需采用 UnoRAG UI。公共 Documents、Versions、
Jobs 生命周期接口尚未作为稳定外部契约发布。

## 当前能力

| 领域 | 产品状态 |
|---|---|
| 身份与工作区 | 本地管理员、Session、邀请、角色、多个 Workspace 与切换已实现 |
| 权限 | PostgreSQL 显式作用域查询、document ACL、Service Key scope、Qdrant 强制过滤与召回复核已实现；PostgreSQL RLS 和用户组管理 UI 待增强 |
| 入库 | TXT、Markdown、DOCX、PDF；DocumentIR/TableIR；LiteParse、自托管或 302.AI MinerU |
| 切分与索引 | 结构优先 profile、递归硬上限、可选叙事语义切分、chunk/section/table 多粒度记录 |
| 检索与问答 | Dense、可选 rerank、面向小中型知识库的应用层 BM25+RRF、问题路由、表格执行、证据裁决、拒答、引用与 SSE |
| 版本与任务 | staging、校验、原子 active 切换、旧版兜底、DBOS 重试/取消/删除/清理/对账 |
| 对外交付 | Compose 参考拓扑、Helm starter、四镜像、分离的运行时数据库角色、备份恢复和发布门禁 |

仓库是单根 Next.js/TypeScript 应用，没有 FastAPI 产品服务、Python 生命周期 Worker、outbox
投影链路或重复业务数据库。Python 仅保留在宿主机验收和配置辅助脚本中。

## 会话与记忆

默认对话使用短期上下文，不强制把每次提问持久化。用户主动归档后，thread/turns 写入
PostgreSQL，可从档案继续对话。追问会做 query rewrite，但不得扩大原始身份的访问范围。

## 产品边界

UnoRAG 当前不把以下方向作为核心承诺：

- 开放式通用 Agent 工具市场；
- 同仓维护多语言 SDK 或 MCP Server；
- 公网暴露 Worker、数据库或向量库；
- 跨会话用户画像和无限期个人记忆；
- 公网多租户 SaaS 计费与多 Region active-active；
- 用 RAG 代替业务数据库处理万行级交易分析。

超大运营数据应优先查询其源数据库。LlamaIndex 或领域查询引擎只有在真实场景证明收益后，
才会作为受控工具接入，而不会成为第二套运行时。

## 交付成熟度

当前 TypeScript 运行时已通过空环境安装、代表性真实文件、浏览器权限、跨作用域隔离、
故障恢复、备份恢复和质量矩阵的 RC 验收，可用于内部预发布和受控试点。该结论绑定具体
版本与测试环境，不等于适用于任意客户环境的通用生产认证。

生产交付仍须使用不可变镜像完成升级/应用回滚、模型与 ParserProvider 故障验收，并在
客户目标环境确认容量、RPO/RTO、监控责任、身份系统和安全策略。详见
[RELEASE.md](./RELEASE.md)。

## 下一阶段

当前实现、缺口与执行顺序由 [STATUS.md](./STATUS.md) 统一维护。产品优先级按“先可安全公开和复验，
再增强客户部署，最后扩展知识能力”排列：

1. **稳定版发布**：素材、NOTICE、SBOM/provenance 和镜像签名已经工程化；在最终精确提交重跑完整
   产品、安全、恢复与容量门禁后发布 `v0.1.0`。
2. **私有部署产品化**：COS 已通过真实环境验收；稳定版后优先推进 OIDC/SSO，再按试点需求选择
   S3 兼容存储、Kubernetes NetworkPolicy/PDB/HPA，以及 Ops Stack 的客户环境容量与故障验收。
3. **知识质量**：在现有真实文件黄金集与 Prompt 门禁上扩充客户问题分类、引用 precision、
   Provider scorecard 和 ChartIR。
4. **平台接口**：稳定 Documents/Versions/Jobs 公共 API、用户组管理和目录同步。

每项新能力都必须回答：是否增强可靠性、可接入性或可交付性；是否有真实评测证明收益；
是否继续保持唯一的权限、版本与检索事实。

## 开源与服务方向

UnoRAG 目标是单一、功能完整的开源产品，不设置社区版、专业版或 AI 工程增强版功能墙。私有化部署、
Ops Stack、Langfuse、评测与通用 Provider 集成在实现后都属于同一产品；“可选”只表示部署依赖和使用
场景不同，不表示源码收费。

项目可通过架构咨询、部署升级、系统集成、迁移、RAG 评测与调优、客户定制、培训和 SLA 支持获得收入。
客户数据、密钥、基础设施配置和合同特定扩展继续保持私有，通用修复与能力在合同允许时回馈主仓库。

源码已经采用 Apache-2.0，GitHub 仓库目前公开可见并仅发布预发行 RC。素材溯源、第三方通知、
SBOM/provenance 与签名已经完成；正式 `v0.1.0` 仍须绑定最终提交执行完整验收并发布稳定材料。
具体决策与发布门槛见 [ADR-0007](./adr/0007-fully-open-source-product-and-services.md)。公网 SaaS 不是
当前版本的前置条件。
