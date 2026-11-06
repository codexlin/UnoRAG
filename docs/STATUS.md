# UnoRAG 当前状态

> 更新日期：2026-11-07
>
> 作用：说明当前 `main` 已经具备什么、尚缺什么，以及下一步按什么顺序推进。
>
> 边界：实现状态以代码为准；验收状态只由 [`evidence/`](./evidence/) 中绑定提交和环境的报告证明。

## 一句话结论

UnoRAG 是一个 **TypeScript-only、可私有部署、具备权限和文档生命周期的开源知识产品**，采用 Apache-2.0。
当前稳定版 [`v0.2.5`](https://github.com/codexlin/UnoRAG/releases/tag/v0.2.5) 已发布，香港正式实例运行
`0.2.5` / `e749e2d`。四个应用镜像通过扫描、Cosign 签名与身份核对，提供 GHCR 与可选 ACR manifest。

本轮修复长正文/链接/行内代码的窄屏越界，以及 ACR 推送错误不可见和 OCI artifact 不兼容；不改变检索、
Provider、数据库 schema 或公共 API。快速测试 **840/840**、真实集成 **82/82**、主干六项 CI 通过。
最终稳定镜像在香港 COS 实例新鲜入库 **7/7**、三轮黄金集 **123/123**、原文下载摘要 **7/7**；
最高轮次 P95 **8.92 秒**，没有提高 15 秒门槛。公网浏览器复验 **36/36**，另有真实无 mock SSE **2/2**。
首轮 30 秒整项预算下的浏览器 **35/36** 保留，复验只调整公网整项预算，没有放宽功能断言。
香港独立项目重做空卷安装、旧版升级/回滚/再升级、隔离 **29/29**、Provider/依赖故障、有界背压、
小样本容量和七份原文恢复对照，结束后已清理。完整归因、前后对比和边界见
[v0.2.5 收口验收](./evidence/2026-11-06-v0.2.5-release-closeout.md)。

发布后的 **25 文件混合业务扩展** 暴露了额外质量缺口：首次正例 78/82、拒答 10/10，P95 8.73 秒，
生命周期 8/8，但总结果 **FAIL**。一条新增扫描预期错误已单列修正；指定文档定位、结构枚举和发布/恢复
来源约束仍需处理，见 [业务矩阵报告](./evidence/2026-11-06-business-matrix-hk.md) 与
[#205](https://github.com/codexlin/UnoRAG/issues/205)。不能用七文件历史 PASS 代替这一更广范围的验收。

`fix/205-business-evidence` 候选分支已补授权文档定位、有界完整目录、表单/清单路由、MinerU 图片脚注、
回答粒度约束、内部来源标记与隐私安全的引用诊断，并修复无关 partial 文档阻断已识别文号的问题；
**尚未合并或部署香港**。上一轮本地新鲜入库/原文摘要各 25/25、生命周期 8/8，完整矩阵 **81/82 + 10/10**，
P95 **8.82 秒**，仍保留机器 **FAIL**。唯一未通过的是正确来源下的“备份校验”连续词匹配差异，未删改
预期事实或把语义复核冒充自动通过。此前引用错误已在真实模型重放中复现机制并修复；历史失败和一次
中断运行全部保留，详见同一业务矩阵报告。
候选快测 **876/876**、真实集成 **82/82**、生产构建与 verify、提交 `0c1ba18` 的远端六项 CI 通过；
这些不是不可变发布镜像或香港环境的重新验收。

2026-11-07 增加可选离线事实正确性诊断与十条版本化校准样本；两轮真实评委调用各完成 12 条评分，
包括历史失败回答的双参考对照。正确改写可获高分，但简短参考答案也能使同一回答得零分，说明不能用
语义分数自动放行。原黄金集、manifest 和历史 FAIL 均未改，产品检索/提示词未调整，香港未部署。
本轮工具快测 **877/877**、离线 Python 测试 **15/15**、verify 通过；不是新增的真实入库或发布稳定性验收。
边界与后续契约审查见同一业务矩阵报告及 [评测说明](./EVALUATION.md#校准词面差异而不是强迫模型复述)。

随后按维护者确认的自然表达规则发布评测契约 v2，保留机器评分并逐条复核。新鲜矩阵 J 入库/原文摘要
各 **25/25**、正例 **83/83**、拒答 **10/10**、生命周期 **8/8**，P95 **6.74 秒**，机器结果 PASS。
但代理逐条复核为 **82 supported + 1 insufficient_evidence，NO_GO**：合同不同条款的期限口径不一致，
答案没有提示歧义；两个原问题重放均复现，两个指定条款对照均能回答各自期限。原文与召回中都存在
相关条款，不是 MinerU 解析失败。缺口跟踪 [#207](https://github.com/codexlin/UnoRAG/issues/207)，
不能用机器全绿或节点 completed 代替语义正确性。当前快测 **879/879**、真实集成 **82/82**、构建与 verify、
提交 `d95c59a` 的六项 CI 通过；产品 `src/` 未变，未开展后续两轮稳定性、香港升级或发布。

随后实现 #207 的候选冲突输出契约、原文/来源校验、确定性歧义展示与内容最小化诊断，并发布评测契约
v3（85 正例、10 拒答，原始文件不变）。**候选尚不合格**：定向固定证据对照通过，但完整新鲜矩阵 K
仅 **82/85 + 9/10、FAIL**；入库/原文摘要各 **25/25**、生命周期 **8/8**，P95 **7.54 秒**。
四项阻断分别是冲突漏判、无关项目引用、论文元信息误拒答，以及无答案时拒答标志与引用不正确。
同输入旧/新裁决对照已复现新增回归，不是 MinerU 故障；不能继续靠堆提示词或只重跑成功样本放行。
快测 **886/886**、真实集成 **82/82**、生产构建与 verify 通过只证明这些检查，不覆盖语义失败。
PR #206 继续 Draft，#205/#207 未关闭，香港稳定版未改；详情与私有证据摘要见同一业务矩阵报告。

默认交付仍是一位客户一套独立实例；Workspace 服务于企业内部治理，不代表公网共享多租户 SaaS。
参考环境通过不等于所有客户拓扑、容量或安全场景已经认证。历史失败保留在
[证据索引](./evidence/README.md)，不被新 PASS 改写。历史 Qdrant 根因继续跟踪
[#193](https://github.com/codexlin/UnoRAG/issues/193)；可选离线 Ragas/DiskCache 的未修补 advisory 跟踪
[#202](https://github.com/codexlin/UnoRAG/issues/202)，不属于四个产品镜像内的 Python 依赖。

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
| 评测 | 版本化黄金集、真实文件矩阵、Prompt Registry、稳定性和延迟门禁；可选 Ragas 首轮 36 条本地诊断待人工校准并有独立依赖风险跟踪；本轮最终稳定镜像三轮 123/123，P95 均低于 15 秒，旧失败保留 |
| 交付 | Compose 参考拓扑、Helm starter、四个 Node 镜像、升级/回滚、备份/恢复工具 |
| 公开接口 | `POST /api/v1/retrieve`、`POST /api/v1/ask` 与 OpenAPI 契约 |

## 已经验证到什么程度

- 当前仓库跟踪超过 100 个 TypeScript/Node 测试文件及版本化测试数据；生成的本地 A/B 报告位于忽略目录，不进入 Git。
- CI 覆盖全历史密钥扫描、Web/TS Core、真实 PostgreSQL migration、镜像构建、原生 PDF/OCR 离线验证、
  依赖审计和品牌残留检查。
- `v0.2.5` 重复执行不可变镜像、Provider 故障、digest 升级/应用回滚、破坏性恢复和生命周期门禁。
  local 文件卷恢复阶段实测 36 秒，七份原文摘要与生效版本均一致；Retrieve 17/17、Ask 6/6、并发上传
  3/3 的容量小样本通过。这些不是通用 RTO 或吞吐 SLA，见
  [当前发布验收](./evidence/2026-11-06-v0.2.5-release-closeout.md)。
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

`v0.2.5` 的不可变镜像、香港环境升级、公网 smoke、Provider 故障和恢复门禁已经完成。历史 PASS 不自动
传递给新提交、新模型、ParserProvider 或客户环境；每个正式交付仍需执行自己的备份恢复、容量、Provider
和故障演练门禁。

`UnoRAG` / `Unobyte` 的正式商标检索仍是维护者的外部法律风险事项，本仓库只记录工程来源和使用政策，
不宣称名称或图形已在任一地区注册。首个稳定版沿用当前项目创建的 UnoRAG 标识；未来视觉升级不改变
代码、数据或 API 兼容性，也不再阻塞工程发布。

公开仓库治理已启用：主干强制 PR 与必需 CI 检查，Private Vulnerability Reporting、Dependabot 安全更新、
Secret Scanning 和 Push Protection 均已开启。

### P1：私有部署产品化

稳定版已完成其原发布范围内的诊断和交付验收；扩展业务质量仍受 #205/#207 阻断。下列产品化缺口尚未实现，按真实私有部署需求排序，
不因此自动进入功能扩张；旧候选报告中的边界仍按原提交解释。

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

本轮 #197 的发布诊断/可选 ACR 通道及 #199 窄屏显示问题已完成修复和最终稳定镜像复验。
下一步先处理矩阵 K 的四项阻断：用完整候选输入固定复现，保住原有最小证据选择和拒答行为，再收敛
#207 的歧义识别。候选需先通过原问题与不同条件/明确条款/优先级对照，再重做 #205 的完整混合矩阵和
两轮稳定性复验，不能将当前失败候选合并或部署。随后扩大真实用户试用；持续收集 #193 的自然失败证据，跟踪 #202 的上游修复；
如再出现异常，应先关联 Request ID、操作、底层分类和上游记录，
不把“重试成功”当作根因证明，也不为没有样本的场景堆新框架。

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
