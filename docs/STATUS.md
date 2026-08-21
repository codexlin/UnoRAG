# UnoRAG 当前状态

> 更新日期：2026-08-17
>
> 作用：说明当前 `main` 已经具备什么、尚缺什么，以及下一步按什么顺序推进。
>
> 边界：实现状态以代码为准；验收状态只由 [`evidence/`](./evidence/) 中绑定提交和环境的报告证明。

## 一句话结论

UnoRAG 已经不是 RAG 原型，而是一个 **TypeScript-only、可私有部署、具备权限和文档生命周期的知识产品**。
仓库已在 GitHub 公开并采用 Apache-2.0，目前最新生产候选为 `v0.1.0-rc.12`；精确候选提交已完成
HK 真实文件、浏览器、隔离、维护恢复与回退前滚复验。在素材权属、完整第三方通知和镜像签名完成前，
仍不应发布稳定 `v0.1.0`，也不应把该单机候选结论扩大为所有部署拓扑的通用生产认证。当前默认
交付是一位客户一套独立实例；Workspace 服务于客户企业内部治理，不代表公网共享多租户 SaaS。

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

- 当前仓库跟踪 106 个测试文件和 23 个测试数据文件；生成的本地 A/B 报告位于忽略目录，不进入 Git。
- CI 覆盖全历史密钥扫描、Web/TS Core、真实 PostgreSQL migration、镜像构建、Helm、依赖审计和品牌残留检查。
- 现有证据覆盖空环境安装、真实文件、浏览器 RBAC、跨 Workspace 隔离、MinerU 302 实链路、故障恢复、
  备份恢复、不可变镜像升级/回滚和 tombstone 生命周期。
- RC.12 报告绑定当前精确提交，覆盖三轮真实文件稳定性、真实浏览器 Workspace 隔离、备份 overlay、
  Qdrant/worker 故障恢复以及 RC.11 回退与 RC.12 再前滚；结论见
  [RC.12 生产候选验收](./evidence/2026-08-12-rc12-production-acceptance.md)。

## 尚未完成

### P0：稳定版发行门禁

1. 完成截图和 `testdata/` fixture 的来源/再分发确认，补齐 `ASSETS.md`；当前 Uno 图形也仍是临时品牌资产。
2. 生成完整第三方 NOTICE/许可证包，完成 libvips/字体再分发审阅；RC.12 四镜像已完成 SBOM/provenance 和漏洞扫描复验。
3. 接入镜像签名；公开仓库已保留完整历史，后续发布仍须扫描所有 refs、tag 和 release assets。
4. 完成 `UnoRAG` / `Unobyte` 名称与图形在目标地区和软件类别的商标检索。

公开仓库治理已启用：主干强制 PR 与五项 CI，Private Vulnerability Reporting、Dependabot 安全更新、
Secret Scanning 和 Push Protection 均已开启。

### P1：私有部署产品化

1. **OIDC / SSO**：已有 Provider 边界和 Session 类型，但没有可交付的 OIDC 实现。
2. **对象存储**：腾讯云 COS 适配器、Compose/Helm 配置及 Mock 契约测试已实现；真实 CAM 凭证下的上传、下载、替换、删除与备份恢复仍待绑定环境验收。其他 S3 兼容存储按试点需求扩展。
3. **Kubernetes 加固**：Helm 是 starter，尚未内置 NetworkPolicy、PDB、HPA 或 digest-native 镜像字段。
4. **身份目录**：group ACL 数据面已存在，用户组管理 UI、SCIM/目录同步尚未完成。
5. **公共生命周期 API**：Documents / Versions / Jobs 仍是 Workspace 内部接口，不是稳定 v1 契约。

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

当前最有杠杆的工作不是继续增加 RAG 路径，而是完成第一个可复验的稳定版本：

1. **发布合规批次**：确认素材/fixture 权属、完整第三方 NOTICE 与镜像签名。
2. **品牌与对外材料批次**：确定正式名称和 Logo，更新产品截图，避免用临时资产发布首个公开版本。
3. **稳定 v0.1.0**：签名 RC.12 等价镜像后，发布源码、镜像 digest、SBOM/provenance 和版本绑定验收报告。
4. **部署增强批次**：先完成 COS 真实凭证验收，再按真实试点需求在 OIDC、其他对象存储、Kubernetes 加固中选择下一条纵向切片。

完成前四项后，UnoRAG 才从“代码和 RC 已成熟”进入“外部用户可安全采用”的阶段。

## 文档权威顺序

1. 当前能力和缺口：本文；
2. 产品承诺：[PRODUCT.md](./PRODUCT.md)；
3. 当前运行时：[ARCHITECTURE.md](./ARCHITECTURE.md)；
4. 安装与运维：[DEPLOYMENT.md](./DEPLOYMENT.md)、[OPERATIONS.md](./OPERATIONS.md)；
5. 发布结论：[RELEASE.md](./RELEASE.md) 与 [`evidence/`](./evidence/)；
6. 历史原因：[ADR 索引](./adr/README.md)。
