# UnoRAG 当前状态

> 更新日期：2026-11-06
>
> 作用：说明当前 `main` 已经具备什么、尚缺什么，以及下一步按什么顺序推进。
>
> 边界：实现状态以代码为准；验收状态只由 [`evidence/`](./evidence/) 中绑定提交和环境的报告证明。

## 一句话结论

UnoRAG 已经不是 RAG 原型，而是一个 **TypeScript-only、可私有部署、具备权限和文档生命周期的知识产品**。
仓库已在 GitHub 公开并采用 Apache-2.0，当前稳定版 [`v0.2.3`](https://github.com/codexlin/UnoRAG/releases/tag/v0.2.3)
已经发布。素材溯源、第三方通知、SBOM/provenance、镜像漏洞扫描和 Cosign 签名均已工程化；COS 真链路、
真实文件、浏览器权限、29 项隔离熔断、维护恢复、回退前滚和受控容量已在最终提交与香港参考环境复验。
这不应扩大为所有部署拓扑的通用生产认证。当前默认交付是一位客户一套独立实例；Workspace 服务于客户
企业内部治理，不代表公网共享多租户 SaaS。

最新 `main` 已加入 Ask 检查点授权、历史来源再授权、流式尝试隔离、入库清单校验和依赖安全更新。
修复后的 `59b4f5f` 不可变候选已通过 7 份新鲜入库、三轮 123/123 Ask、29 项完整隔离、20 项浏览器，
以及升级回滚、Provider 故障诊断和破坏性恢复，结论为 **RC GO，可进入受控试点**，见
[该隔离候选报告](./evidence/2026-11-04-59b4f5f-candidate-acceptance.md)；旧候选的 NO-GO 未改写。
香港当前运行 `b0222ea` / `0.2.3-dev+b0222ea2716e`，已包含 PR #192 的比较上下文、图源保留与
Qdrant 失败诊断。精确主干 CI、签名四镜像升级、新鲜入库 7/7、三轮 Ask **123/123**、完整隔离
**29/29** 和桌面/移动自动化 **28/28** 通过；三轮 P95 为 **9.58 / 8.98 / 9.79 秒**，没有提高 15 秒门槛。
#189/#190 目标用例各 3/3；受控 Qdrant 停机时，响应 Request ID、失败节点、连接错误码能在 PG、日志和
浏览器详情关联，恢复后同一 Web 进程回答成功。当前证据见
[香港候选复验](./evidence/2026-11-06-b0222ea-hk-acceptance.md)。

这次结论仅覆盖报告列明的候选升级与验收，不是完整交付门禁或新的稳定版：本轮没有重做空安装、完整
回滚前滚、破坏性 restore、容量或完整 Provider 故障矩阵；HK 宿主机 offline preflight 因无 pnpm 退出 2，
不能写成 PASS。复杂 PDF 曾出现较长解析与串行排队；轮询期间新建库的自动选中也有单次待复现观察。
旧 d9b1377 的 **118/123 FAIL**、c066377 的延迟 FAIL 和本地 **40/41 FAIL** 均保留，不能被本轮 PASS 改写。
历史 Qdrant 503 根因仍未知，继续跟踪 [#193](https://github.com/codexlin/UnoRAG/issues/193)。
排查、机制与效果/成本解释见 [修复案例](./evidence/2026-11-05-comparison-lineage-fix.md)。

下一版源码正在按 `0.2.4` 候选收口：已重现并修复后台轮询取消写后刷新导致新库未选中的竞态，
补充 PDF 分阶段实测计时和安全关联日志；不改变解析策略、并发、超时或金标。当前本地快速测试
817/817、真实集成 82/82、桌面/移动专项 4/4 通过。完整生产构建浏览器、空安装、升级回退、
恢复和容量门禁尚待该候选验证；源码版本号上调不代表已经发布或部署，香港仍为上文 `b0222ea`。

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
| 原生运行中心 | 已实现健康、任务、解析、模型、生命周期、告警、Ask/入库阶段瀑布与 P50/P95；香港已验证请求筛选/详情、Qdrant 失败节点与 Request ID 关联、桌面/移动展示及同进程恢复 |
| 标准观测 | 可选 OTel Collector、Prometheus、Grafana、Loki、Tempo 与 Alertmanager |
| AI 工程观测 | 可选 metadata-only Langfuse Trace 与评测分数发布，不采集问题或文档正文 |
| 评测 | 版本化黄金集、真实文件矩阵、Prompt Registry、稳定性和延迟门禁；可选 Ragas 首轮 36 条本地诊断待人工校准；当前香港候选三轮 123/123、P95 全部低于 15 秒，旧失败保留 |
| 交付 | Compose 参考拓扑、Helm starter、四个 Node 镜像、升级/回滚、备份/恢复工具 |
| 公开接口 | `POST /api/v1/retrieve`、`POST /api/v1/ask` 与 OpenAPI 契约 |

## 已经验证到什么程度

- 当前仓库跟踪超过 100 个 TypeScript/Node 测试文件及版本化测试数据；生成的本地 A/B 报告位于忽略目录，不进入 Git。
- CI 覆盖全历史密钥扫描、Web/TS Core、真实 PostgreSQL migration、镜像构建、Helm、依赖审计和品牌残留检查。
- `v0.2.3` 在不改变公开 API、检索实现或数据库 schema 的前提下，把不可变候选、Provider 故障、
  digest 升级/应用回滚、破坏性恢复和生命周期不变量固化为发布门禁。隔离 RC、香港原位升级、产品 smoke、
  公网安全头及桌面/移动浏览器均通过；恢复耗时 50 秒、数据丢失为 0，结论见
  [v0.2.3 Release Confidence 发布验收](./evidence/2026-09-25-v0.2.3-release-confidence.md)。
- Library 创建、更新、删除请求、删除完成与删除失败使用统一审计语义；事务内事件与异步 Worker 终态通过
  同一 Request ID 关联，描述正文不会进入审计。空库同步删除、带文件异步删除、真实 Qdrant 停机和本地
  对象存储权限故障均已验证；运行中心可展示原因、阶段瀑布和 `jobs.delete_failed` 告警，恢复后对象与向量
  被清理且旧失败记录继续保留。当前汇总结论见
  [v0.2.3 Release Confidence 发布验收](./evidence/2026-09-25-v0.2.3-release-confidence.md)。
- 备份产物完整性、删卷和恢复已在隔离 RC 真实执行；香港在线实例完成升级前备份及校验，但未做破坏性原地
  restore。客户环境仍须按自己的 RPO/RTO、对象存储策略和维护窗口单独演练。
- 旧版本逐版结果不再复制到状态页；需要追溯时使用 [CHANGELOG](../CHANGELOG.md)、
  [GitHub Releases](https://github.com/codexlin/UnoRAG/releases) 和 Git 历史。

## 持续门禁与未完成项

### 每次发布必须重复的门禁

`v0.2.3` 的不可变镜像、香港环境升级、公网 smoke、Provider 故障和恢复门禁已经完成。历史 PASS 不自动
传递给新提交、新模型、ParserProvider 或客户环境；每个正式交付仍需执行自己的备份恢复、容量、Provider
和故障演练门禁。

`UnoRAG` / `Unobyte` 的正式商标检索仍是维护者的外部法律风险事项，本仓库只记录工程来源和使用政策，
不宣称名称或图形已在任一地区注册。首个稳定版沿用当前项目创建的 UnoRAG 标识；未来视觉升级不改变
代码、数据或 API 兼容性，也不再阻塞工程发布。

公开仓库治理已启用：主干强制 PR 与五项 CI，Private Vulnerability Reporting、Dependabot 安全更新、
Secret Scanning 和 Push Protection 均已开启。

### P1：私有部署产品化

当前候选的公共拒绝映射、Judge 故障语义与诊断、多来源黄金集契约已修复并重新验收。后续代码已补上
[#177 验收脚本清理](https://github.com/codexlin/UnoRAG/issues/177) 的产品删除与退出收尾、已安装的 Mammoth
版本标签，以及运行中心 Judge detail 白名单展示；旧候选报告中的边界仍按原提交保留，新代码不继承旧 PASS。
继续保持质量和运维优先，下列产品化缺口仍未实现，不因此自动进入功能扩张。

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

当前候选已完成 #189/#190 的合并、不可变镜像与香港质量复验；延迟满足原门槛，不把
[#185](https://github.com/codexlin/UnoRAG/issues/185) 已关闭的历史问题继续列成当前阻塞。
下一步补齐尚未重复的交付门禁，并持续收集 #193 的自然失败证据；如再出现异常，应先关联
Request ID、操作、底层分类和上游记录，再决定修复，不把“重试成功”当作根因证明。

1. **稳定性与恢复**：固化客户环境验收模板，覆盖容量、备份 restore、队列拥塞、Provider 降级和责任人；
2. **质量回归运营**：保留现有硬门禁，以线上失败样本扩充问题类型、文档布局和 Provider 基线；
3. **按证据扩展检索**：只有客户语料证明收益后再推进 ChartIR、Qdrant native sparse 或更复杂执行路径；
4. **企业身份后置**：OIDC/SSO、用户组管理和 SCIM 保留清晰边界，但不先于知识质量与稳定性投入。

## 文档权威顺序

1. 当前能力和缺口：本文；
2. 当前运行时：[ARCHITECTURE.md](./ARCHITECTURE.md)；
3. 安装与运维：[DEPLOYMENT.md](./DEPLOYMENT.md)、[OPERATIONS.md](./OPERATIONS.md)；
4. 对外接口：[INTEGRATION.md](./INTEGRATION.md)；
5. 发布结论：[RELEASE.md](./RELEASE.md) 与 [`evidence/`](./evidence/)；
6. 历史原因：[ADR 索引](./adr/README.md)。
