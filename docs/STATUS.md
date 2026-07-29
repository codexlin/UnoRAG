# UnoRAG 实现状态

> 更新：2026-07-30
>
> 本页是“代码已经做到了什么”的权威摘要。产品定位见
> [PRODUCT.md](./PRODUCT.md)，技术设计见 [ARCHITECTURE.md](./ARCHITECTURE.md)，
> 尚未完成的工作见 [ROADMAP.md](./ROADMAP.md)。

状态定义：

- **可用**：主路径、测试和对应运行代码已存在。
- **部分可用**：核心能力存在，但产品面、集群化或企业集成仍有明确缺口。
- **规划中**：不应在销售、README 或验收中表述为已交付。

## 产品与控制面

| 能力 | 状态 | 当前实现与边界 |
|---|---|---|
| 私有部署 bootstrap | 可用 | 幂等创建 organization、初始 workspace、admin 与 owner membership |
| 本地身份与会话 | 可用 | 密码登录、独立 session secret、服务间 HMAC；生产 fail-closed |
| Organization | 部分可用 | 数据模型与 organization owner/admin 权限已存在；没有创建多 organization、组织管理或角色变更 UI |
| Workspace | 可用 | organization owner/admin 可创建；成员可列出并切换其有权访问的 workspace；创建支持幂等键 |
| Workspace 生命周期 | 部分可用 | 创建和切换已交付；rename/archive/delete 尚无产品 API/UI |
| 成员与邀请 | 可用 | magic link 邀请，viewer/editor/admin；owner 不通过邀请授予 |
| OIDC/SSO | 规划中 | provider 接口已预留，但没有可运行的 OIDC callback、LDAP 或组织同步 |
| 文库 | 可用 | Next.js `app.libraries` 是产品事实源；Outbox 幂等投影到 RAG 数据面 |
| 文档生命周期 | 可用 | 上传、替换、重索引、删除、版本、active pointer、Job 进度与取消 |
| 文档 ACL | 部分可用 | workspace / restricted、指定成员、principal/group 数据面过滤已实现；组管理和组织目录同步 UI 未实现 |
| 审计 | 可用 | 登录、Service Key、文库、文档、Workspace 等关键控制面操作落审计 |

## 入库与知识建模

| 能力 | 状态 | 当前实现与边界 |
|---|---|---|
| 格式支持 | 可用 | TXT、Markdown、PDF、DOCX、CSV、XLSX；HTML 明确不支持 |
| 本地 PDF | 可用 | PyMuPDF 文字层解析与复杂度探测 |
| 扫描/复杂 PDF | 可用 | MinerU self-hosted 和 302 provider adapter；超时、限流、预算、熔断、降级与出域许可 |
| DocumentIR | 可用 | heading、paragraph、list、code、table、figure、equation、page/bbox/reading order |
| 策略化切分 | 可用 | `precise`、`balanced`、`narrative`、`table_heavy`；结构优先、递归兜底、受限语义切分 |
| TableIR | 可用 | 表头、列类型、单位、规范化值、行、汇总行、脚注、页码、bbox、置信度 |
| 跨页表 | 可用 | 相邻 occurrence、续表表头与噪声节点处理；真实复杂表仍应按客户样本验收 |
| 中小表索引 | 可用 | 原表/摘要/行组分层，行组重复表头并保留 source coordinates |
| 超大表 SQL 执行 | 规划中 | 未引入 DuckDB；当前定位是将真正的业务大表交给数据库/业务查询系统 |
| ChartIR | 规划中 | figure 可进入 DocumentIR，但图表数值理解还不是独立、可承诺的执行路径 |

## 版本、任务与一致性

| 能力 | 状态 | 当前实现与边界 |
|---|---|---|
| Job 事实源 | 可用 | `app.jobs`；`FOR UPDATE SKIP LOCKED`、lease、heartbeat、retry/dead、取消 |
| 原子版本切换 | 可用 | staging generation 校验后切 active；失败不覆盖旧 active |
| Desired version 保护 | 可用 | 后完成的旧任务不能覆盖较新的目标版本 |
| Generation cleanup | 可用 | 延迟队列、claim/status、清理器；lifecycle worker 周期执行，也提供独立入口 |
| 文库投影一致性 | 可用 | transactional outbox、retry/dead、reconcile、专用 internal projection API |
| 对象存储 | 部分可用 | 生产参考为共享卷/PVC；S3/MinIO 一等 adapter 尚未交付 |

## 检索、问答与评测

| 能力 | 状态 | 当前实现与边界 |
|---|---|---|
| 检索隔离 | 可用 | organization/workspace/library/active generation/ACL 强制过滤 |
| Dense / hybrid / rerank | 可用 | dense 基线，可选 BM25+RRF 与 rerank；失败可观测并降级 |
| QueryRouter / RetrievalPlan | 可用 | fact、follow-up、summary、compare、table、section lookup、ambiguous |
| LangGraph Ask | 可用 | rewrite、retrieve、judge、retry、generate/refuse；表格受限执行路径 |
| 会话 | 可用 | 默认临时短记忆；主动归档后持久化并可续聊 |
| 引用与拒答 | 可用 | citation adjudication、evidence coverage、no-hit/weak-evidence refusal |
| 表格问答 | 可用 | 文档绑定、表实例定位、行条件/比较/单位解析与命中行引用 |
| 图表问答 | 部分可用 | 可引用解析出的 figure/文本；没有 ChartIR 数值执行保证 |
| 黄金集与 release gate | 可用 | deterministic eval、隔离 fuse、策略 parity、真实文件与 live baseline 工具 |
| 反馈闭环 | 部分可用 | trace/archive/debug 已存在；用户反馈审核后自动进入 eval case 的产品流程未实现 |
| 成本与完整 OTel | 部分可用 | 结构化事件、trace 与健康状态存在；集中 OTel、成本账本和管理面板未完成 |

## API 与集成

| 能力 | 状态 | 当前实现与边界 |
|---|---|---|
| 浏览器 BFF | 可用 | 浏览器只访问 Next.js；RequestContext 绑定 method/path/body/jti |
| Service Key | 可用 | hash 存储、scope、吊销、审计与可选限流 |
| Retrieve / Ask v1 | 可用 | 冻结契约、OpenAPI、稳定错误码；Next 验证后转内部 HMAC |
| Python SDK | 可用 | 0.1.0，同步 retrieve/ask |
| MCP Server | 可用 | 0.1.0，基于 Python SDK 的只读知识工具 |
| 对外 Documents/Versions/Jobs | 规划中 | 产品 UI 可管理，但尚无面向客户系统的公开生命周期 API |
| Answer/stream 公共资源 | 规划中 | 当前公开契约名称仍为 Ask；内部 Workspace 支持 SSE |
| OpenAI-compatible | 规划中 | 不存在可承诺 endpoint |
| TypeScript SDK | 规划中 | 等完整公共契约稳定后再生成或实现 |

## 部署与运行

| 能力 | 状态 | 当前实现与边界 |
|---|---|---|
| Docker Compose | 可用 | web、migrator、api、lifecycle worker、outbox worker 与依赖服务 |
| 数据库运行身份 | 可用 | Web、API、lifecycle worker、outbox、RAG read 使用五个独立登录；DDL 仅 migrator；升级时重置并验证权限 |
| Helm | 部分可用 | 起步 chart；未包含 HPA、PDB、NetworkPolicy 和完整容量策略 |
| 发布镜像 | 可用 | web、migrator、api、outbox 四目标；ACR/GHCR、digest manifest、Trivy HIGH/CRITICAL gate |
| 升级/回滚 | 可用 | preflight、pull、migration、drain、smoke 与回滚 runbook |
| 备份/恢复 | 可用 | PostgreSQL、文档、Qdrant 的脚本与非破坏恢复演练；客户上线仍须实测 RPO/RTO |
| 运行告警 | 部分可用 | 最低健康/队列告警与 webhook 演练已存在；客户监控平台接管需交付时配置 |
| SBOM/签名 | 规划中 | CVE 扫描已实现；SBOM、Cosign 和 provenance 未实现 |

## 当前发布判断

`webch` 是模拟线上拓扑的预发布环境，不是正式客户生产环境。2026-07-28/29
完成了真实 HTTPS 浏览器主路径、多 Workspace 隔离、真实文件入库、故障注入、
非破坏恢复和发布后健康检查，未发现阻断故障。24 小时 soak 属于持续观察项，
不阻塞预发布基线提交。

2026-07-30 已在校验备份后将 webch 全新重置为纯 UnoRAG 运行栈。新环境使用
`unorag-webch` Compose project、`unorag` PostgreSQL database/user、
`unorag_chunks` Qdrant collection 与 `/opt/unorag` 源码目录；公网
upload → ask → isolation → replace → delete 与生命周期巡检通过，旧运行容器、
volume 和路径已退出当前运行面。

同日完成 webch 2 vCPU / 1.8 GiB 最低规格短阶梯容量基线：Retrieve、Ask、
普通入库和真实 MinerU 扫描 PDF 全部通过。该规格下 Ask 在 10 并发后吞吐约
`0.93 req/s` 不再增长，20 并发 P95 为 `21.13s`；建议低并发试点以 5 个
Ask in-flight 为初始预算。详细证据见
[`acceptance/reports/2026-07-30-webch-capacity-baseline.md`](./acceptance/reports/2026-07-30-webch-capacity-baseline.md)。
这仍不是客户目标硬件或持续负载 SLA。

这不等于对任意客户环境宣称通用 production-ready。正式交付仍必须根据客户环境确认：

1. OIDC/本地身份选择与组织权限模型；
2. 预计文档量、并发量、模型限额和 P50/P95；
3. S3/PVC、备份、RPO/RTO 与恢复责任；
4. 告警接收方、值守和升级窗口；
5. 数据出域、MinerU provider 与密钥管理；
6. Helm/网络/镜像签名等客户合规要求。

## 最高优先级缺口

1. **公开文档生命周期 API**：让客户系统不依赖 Workspace 完成 Documents /
   Versions / Jobs。
2. **OIDC/SSO 真实 Provider**：把现有接口接到至少一个可验收的企业身份源。
3. **对象存储抽象**：交付 S3/MinIO，消除多副本 Worker 对共享 PVC 的依赖。
4. **客户目标容量基线**：webch 最低规格短阶梯已完成；仍需在客户目标规格记录
   稳态并发、队列、模型/MinerU 限额和 P50/P95。
5. **Kubernetes 与供应链硬化**：HPA/PDB/NetworkPolicy、SBOM、签名。
6. **产品治理补齐**：Workspace rename/archive/delete、用户组管理与反馈闭环。

## 兼容与发布约束

- `webch` 已通过完整 upgrade 应用 `0012_organization-workspaces.sql`、
  `0013_reconcile_library_terminal_status.sql`，并完成登录、Workspace
  创建/切换、Library 状态收敛和回滚 smoke；预发布迁移滞后已关闭。
- `x-unorag-*`、`unorag-control-plane` 与 `UNORAG_*` 是唯一内部 HMAC
  命名；旧品牌 Header、issuer 和 Secret fallback 已在纯 UnoRAG 基线中移除。
- webch 已在 2026-07-30 以全新数据卷完成纯 UnoRAG bootstrap；重置前备份和旧
  源码仅保留在 `/opt/backups`，不属于当前运行路径。
- edge health 返回控制面/数据面协议与各自 build ref，发布清单继续使用
  digest。协议缺失或不一致必须阻断升级。
- `81778c5` 已将运行时数据库切换为五个独立登录，FastAPI 启动不再执行 DDL；
  `webch` 已通过迁移、权限断言与 upload → ask → isolation → replace → delete
  pilot。全生命周期巡检改由短生命周期 ops job 执行，不扩大 outbox 账号权限。
