# UnoRAG 当前状态

> 更新日期：2026-08-23
>
> 作用：说明当前 `main` 已经具备什么、尚缺什么，以及下一步按什么顺序推进。
>
> 边界：实现状态以代码为准；验收状态只由 [`evidence/`](./evidence/) 中绑定提交和环境的报告证明。

## 一句话结论

UnoRAG 已经不是 RAG 原型，而是一个 **TypeScript-only、可私有部署、具备权限和文档生命周期的知识产品**。
仓库已在 GitHub 公开并采用 Apache-2.0，首个稳定版 [`v0.1.0`](https://github.com/codexlin/UnoRAG/releases/tag/v0.1.0)
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
     ├── Redis: Ask 短期会话记忆
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
| 本地登录与恢复管理员 | 已实现；Session Cookie、密码轮换与最小密钥要求有测试 |
| Organization / 多 Workspace | 已实现创建、切换、成员邀请与 viewer/editor/admin/owner 权限 |
| 文库与文档治理 | 已实现创建、上传、替换、重索引、删除、版本和任务视图 |
| 文档 ACL | 已实现 Workspace / principal / group 作用域及 Qdrant 检索前强制过滤 |
| Service Key | 已实现带 scope 的密钥创建、撤销和 Retrieve / Ask 调用 |
| 审计 | 已实现 Workspace 作用域审计查询与 CSV 导出 |

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
| 原生运行中心 | 已实现作用域内健康、任务、解析、模型、生命周期与告警状态 |
| 标准观测 | 可选 OTel Collector、Prometheus、Grafana、Loki、Tempo 与 Alertmanager |
| AI 工程观测 | 可选 metadata-only Langfuse Trace 与评测分数发布，不采集问题或文档正文 |
| 评测 | 版本化黄金集、真实文件矩阵、Prompt Registry、稳定性和延迟门禁 |
| 交付 | Compose 参考拓扑、Helm starter、四个 Node 镜像、升级/回滚、备份/恢复工具 |
| 公开接口 | `POST /api/v1/retrieve`、`POST /api/v1/ask` 与 OpenAPI 契约 |

## 已经验证到什么程度

- 当前仓库跟踪 111 个 TypeScript/Node 测试文件和 23 个测试数据文件；生成的本地 A/B 报告位于忽略目录，不进入 Git。
- CI 覆盖全历史密钥扫描、Web/TS Core、真实 PostgreSQL migration、镜像构建、Helm、依赖审计和品牌残留检查。
- 现有证据覆盖空环境安装、真实文件、浏览器 RBAC、跨 Workspace 隔离、MinerU 302 实链路、故障恢复、
  备份恢复、不可变镜像升级/回滚和 tombstone 生命周期。
- `v0.1.0` 已以四个独立稳定 digest 固定、Trivy 扫描和 Cosign 签名发布；香港环境通过原位升级、
  pilot smoke、29 项隔离熔断、Retrieve 75/75、Ask 37/37、生命周期 7/7、真实 MinerU 图表 PDF、
  Qdrant/worker 故障恢复和应用回滚前滚。结论见
  [v0.1.0 稳定版验收](./evidence/2026-08-23-v0.1.0-release-acceptance.md)。
- 备份产物完整性和可解析性已在最终候选验证；当前在线实例未执行破坏性原地 restore，客户环境仍须按自己的
  RPO/RTO 和维护窗口演练。

## 尚未完成

### P0：稳定版维护门禁

`v0.1.0` 的源码标签、四镜像、digest manifest、校验和、release notes、供应链材料和版本绑定验收均已
完成。后续补丁版本必须继续执行同一门禁，历史 PASS 不自动传递给新提交、新模型、ParserProvider 或客户
环境。当前在线版本与稳定 manifest 完全一致。

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
3. Provider scorecard、更多客户问题类型、引用 precision 与复杂跨页表金标仍需扩充。
4. 万行级表格 SQL 执行被有意排除；这类数据应优先接入源数据库或独立查询工具。

### 当前明确不做

- 公网多租户 SaaS 计费、跨 Region active-active；
- 同仓维护 Python SDK、MCP Server 或开放式 Agent 工具市场；
- 跨会话用户画像和无限期个人记忆；
- 为目录整齐而强制迁移 monorepo；只有出现真实的独立构建边界或多个消费者时才提取 package。

## 建议的下一步

当前最有杠杆的工作不是继续增加通用 RAG 路径，而是围绕稳定版补齐真实采用链路：

1. **OIDC / SSO 纵向切片**：优先补齐私有部署最常见的企业身份接入，并保持本地管理员恢复路径；
2. **身份治理**：实现用户组管理 UI，再根据真实客户目录选择 SCIM 或特定 Provider 同步；
3. **客户环境验收模板**：把容量、备份恢复、Provider、责任人和 Go/No-Go 固化为可复用交付清单；
4. **知识质量扩展**：以客户金标决定 ChartIR、Provider scorecard、native sparse 和复杂跨页表的顺序。

## 文档权威顺序

1. 当前能力和缺口：本文；
2. 产品承诺：[PRODUCT.md](./PRODUCT.md)；
3. 当前运行时：[ARCHITECTURE.md](./ARCHITECTURE.md)；
4. 安装与运维：[DEPLOYMENT.md](./DEPLOYMENT.md)、[OPERATIONS.md](./OPERATIONS.md)；
5. 发布结论：[RELEASE.md](./RELEASE.md) 与 [`evidence/`](./evidence/)；
6. 历史原因：[ADR 索引](./adr/README.md)。
