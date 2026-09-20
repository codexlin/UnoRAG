# UnoRAG 当前状态

> 更新日期：2026-09-20
>
> 作用：说明当前 `main` 已经具备什么、尚缺什么，以及下一步按什么顺序推进。
>
> 边界：实现状态以代码为准；验收状态只由 [`evidence/`](./evidence/) 中绑定提交和环境的报告证明。

## 一句话结论

UnoRAG 已经不是 RAG 原型，而是一个 **TypeScript-only、可私有部署、具备权限和文档生命周期的知识产品**。
仓库已在 GitHub 公开并采用 Apache-2.0，当前稳定版 [`v0.2.2`](https://github.com/codexlin/UnoRAG/releases/tag/v0.2.2)
已经发布。素材溯源、第三方通知、SBOM/provenance、镜像漏洞扫描和 Cosign 签名均已工程化；COS 真链路、
真实文件、浏览器权限、29 项隔离熔断、维护恢复、回退前滚和受控容量已在最终提交与香港参考环境复验。
这不应扩大为所有部署拓扑的通用生产认证。当前默认交付是一位客户一套独立实例；Workspace 服务于客户
企业内部治理，不代表公网共享多租户 SaaS。

## 当前运行时

```text
Browser / customer application
             ↓
Next.js product + Knowledge API
     ├── PostgreSQL: 唯一业务事实源
     ├── Redis: 可撤销登录会话、分布式限流、Ask 短期记忆
     ├── Qdrant: 带作用域的检索投影
     └── DBOS Worker
            ├── LiteParse / MinerU
            ├── DocumentIR / TableIR
            └── Parse → Chunk → Embed → Validate → Activate
```

- 产品运行时全部是 Node.js/TypeScript；没有 FastAPI 产品服务、Python 生命周期 Worker 或 outbox 投影链路。
- Python 只用于少量宿主机验收、容量分析和测试数据生成，不拥有业务状态。
- 浏览器与外部客户应用只进入 Next.js；Worker、数据库、Qdrant 和 ParserProvider 不作为公网入口。

## 已经具备

### 产品与安全

| 能力 | 当前状态 |
|---|---|
| 本地登录与恢复管理员 | 已实现；每实例唯一初始密码、首次强制改密、Session Cookie、密码轮换与最小密钥要求有测试 |
| Organization / 多 Workspace | 已实现创建、切换、成员邀请与 viewer/editor/admin/owner 权限 |
| 文库与文档治理 | 已实现创建、上传、替换、重索引、删除、版本和任务视图 |
| 文档 ACL | 已实现 Workspace / principal / group 作用域及 Qdrant 检索前强制过滤 |
| Service Key | 已实现带 scope 的密钥创建、撤销和 Retrieve / Ask 调用 |
| 审计 | 已实现 Workspace 作用域审计独立页面、搜索、详情下钻、分页查询和 CSV 导出 |

### 文档、检索与回答

| 能力 | 当前状态 |
|---|---|
| 输入格式 | TXT、Markdown、DOCX、数字 PDF 与扫描/复杂 PDF 路由 |
| 解析 | LiteParse 本地默认；MinerU self-hosted 与 302.AI Provider 可选 |
| 中间表示 | DocumentIR / TableIR 保留章节、页面、表头、单位、行组和来源信息 |
| 切分 | 结构优先；递归硬上限；长叙事可选语义切分；表格按原表、摘要和行组分层 |
| 索引 | chunk / section / table 多粒度 Qdrant 记录，包含 ACL、版本和 generation 载荷 |
| 检索 | Dense、可选 rerank、面向小中型知识库的应用层 BM25 + RRF、强制作用域过滤与引用映射 |
| Ask | LangGraph.js 路由、计划、改写、检索、证据裁决、拒答、表格执行和 SSE 生成 |
| 表格回答 | 支持条件、比较、单位和聚合的确定性执行，并引用实际贡献行组 |
| 会话 | 临时追问上下文与主动归档；归档 thread/turn 可继续对话 |

### 生命周期、运维与交付

| 能力 | 当前状态 |
|---|---|
| 持久任务 | DBOS 执行 ingest、ACL projection、delete、cleanup，支持重试、取消、对账与隔离 |
| 原子版本 | 新 generation 校验通过后激活；失败时旧版本继续服务 |
| 清理 | 旧 generation、Ask runs 和 tombstone 有维护命令与可观测结果 |
| 原生运行中心 | 已实现健康、任务、解析、模型、生命周期、告警、Ask/入库阶段瀑布与 P50/P95；历史错误可下钻原因和关联 ID |
| 标准观测 | 可选 OTel Collector、Prometheus、Grafana、Loki、Tempo 与 Alertmanager |
| AI 工程观测 | 可选 metadata-only Langfuse Trace 与评测分数发布，不采集问题或文档正文 |
| 评测 | 版本化黄金集、真实文件矩阵、Prompt Registry、稳定性和延迟门禁 |
| 交付 | Compose 参考拓扑、Helm starter、四个 Node 镜像、升级/回滚、备份/恢复工具 |
| 公开接口 | `POST /api/v1/retrieve`、`POST /api/v1/ask` 与 OpenAPI 契约 |

## 已经验证到什么程度

- 当前仓库跟踪超过 100 个 TypeScript/Node 测试文件及版本化测试数据；生成的本地 A/B 报告位于忽略目录，不进入 Git。
- CI 覆盖全历史密钥扫描、Web/TS Core、真实 PostgreSQL migration、镜像构建、Helm、依赖审计和品牌残留检查。
- `v0.2.2` 已完成原生告警去抖与恢复、Redis 分布式限流、Session 即时撤销、安全响应头、默认/高级
  配置分层、旧运行时清理与大模块职责拆分。四镜像扫描、签名、空环境安装、香港原位升级、公网安全、
  三轮真实文件、故障恢复和浏览器验收全部通过；每轮 36/36 正例、5/5 拒答，最大 P95 `13.677s`，
  结论见 [v0.2.2 Production Hardening 发布验收](./evidence/2026-09-20-v0.2.2-production-hardening-release.md)。
- Library 创建、更新、删除请求、删除完成与删除失败现在使用统一审计语义；事务内事件与异步 Worker
  终态通过同一 Request ID 关联，描述正文不会进入审计。真实 PostgreSQL 和本地 Docker 浏览器链路已验证
  空库同步删除与带文件异步删除，结论见
  [Library CRUD 审计验收](./evidence/2026-09-15-library-crud-audit.md)。
- 删除恢复闭环已通过真实 Qdrant 停机和本地对象存储权限故障验证：运行中心展示原因、阶段瀑布和
  `jobs.delete_failed` 告警，管理员可从页面创建新的幂等 DBOS 清理任务，恢复后对象和向量均被删除，
  旧失败记录继续保留。结论见
  [删除故障恢复验收](./evidence/2026-09-17-library-delete-fault-recovery.md)。
- 备份产物完整性和可解析性已在最终候选验证；当前在线实例未执行破坏性原地 restore，客户环境仍须按自己的
  RPO/RTO 和维护窗口演练。
- 旧版本逐版结果不再复制到状态页；需要追溯时使用 [CHANGELOG](../CHANGELOG.md)、
  [GitHub Releases](https://github.com/codexlin/UnoRAG/releases) 和 Git 历史。

## 持续门禁与未完成项

### 每次发布必须重复的门禁

`v0.2.2` 的不可变镜像、香港环境升级、公网 smoke、完整真实文件和故障恢复门禁已经完成。历史 PASS 不自动
传递给新提交、新模型、ParserProvider 或客户环境；每个正式交付仍需执行自己的备份恢复、容量、Provider
和故障演练门禁。

`UnoRAG` / `Unobyte` 的正式商标检索仍是维护者的外部法律风险事项，本仓库只记录工程来源和使用政策，
不宣称名称或图形已在任一地区注册。首个稳定版沿用当前项目创建的 UnoRAG 标识；未来视觉升级不改变
代码、数据或 API 兼容性，也不再阻塞工程发布。

公开仓库治理已启用：主干强制 PR 与五项 CI，Private Vulnerability Reporting、Dependabot 安全更新、
Secret Scanning 和 Push Protection 均已开启。

### P1：私有部署产品化

1. **OIDC / SSO**：已有 Provider 边界和 Session 类型，但没有可交付的 OIDC 实现。
2. **Kubernetes 加固**：Helm 是 starter，尚未内置 NetworkPolicy、PDB、HPA 或 digest-native 镜像字段。
3. **身份目录**：group ACL 数据面已存在，用户组管理 UI、SCIM/目录同步尚未完成。
4. **公共生命周期 API**：Documents / Versions / Jobs 仍是 Workspace 内部接口，不是稳定 v1 契约。
5. **其他对象存储**：腾讯云 COS 已通过真实生命周期与容量验收；S3 兼容 Provider 按真实试点需求扩展。

### P2：知识质量扩展

1. ChartIR 与图表数值理解尚未实现；`mixed-charts.pdf` 当前只验证叙事文字恢复。
2. 应用层 BM25 + RRF 仅作为小中型知识库模式；Qdrant native sparse 是否值得迁移仍需客户语料与容量评测证明。
3. Provider scorecard、Citation precision、复杂跨页表和低对比扫描已经成为发布硬门禁；后续按真实失败
   样本继续扩充客户问题类型与 fixture，而不是为数量堆用例。
4. 万行级表格 SQL 执行被有意排除；这类数据应优先接入源数据库或独立查询工具。

### 当前明确不做

- 公网多租户 SaaS 计费、跨 Region active-active；
- 同仓维护 Python SDK、MCP Server 或开放式 Agent 工具市场；
- 跨会话用户画像和无限期个人记忆；
- 为目录整齐而强制迁移 monorepo；只有出现真实的独立构建边界或多个消费者时才提取 package。

## 建议的下一步

当前最有杠杆的工作不是继续增加通用 RAG 路径，而是把现有能力做得更稳定、更可解释：

1. **稳定性与恢复**：固化客户环境验收模板，覆盖容量、备份 restore、队列拥塞、Provider 降级和责任人；
2. **质量回归运营**：保留现有硬门禁，以线上失败样本扩充问题类型、文档布局和 Provider 基线；
3. **按证据扩展检索**：只有客户语料证明收益后再推进 ChartIR、Qdrant native sparse 或更复杂执行路径；
4. **企业身份后置**：OIDC/SSO、用户组管理和 SCIM 保留清晰边界，但不先于知识质量与稳定性投入。

## 文档权威顺序

1. 当前能力和缺口：本文；
2. 产品承诺：[PRODUCT.md](./PRODUCT.md)；
3. 当前运行时：[ARCHITECTURE.md](./ARCHITECTURE.md)；
4. 安装与运维：[DEPLOYMENT.md](./DEPLOYMENT.md)、[OPERATIONS.md](./OPERATIONS.md)；
5. 发布结论：[RELEASE.md](./RELEASE.md) 与 [`evidence/`](./evidence/)；
6. 历史原因：[ADR 索引](./adr/README.md)。
