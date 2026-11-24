# UnoRAG 当前状态

> 更新日期：2026-11-25。本文只维护当前成熟度、已知限制和下一步；架构细节见 [ARCHITECTURE](./ARCHITECTURE.md)，逐版结果见 [验收索引](./evidence/README.md)。

## 当前结论

UnoRAG 是 Apache-2.0 开源、TypeScript-only 的企业级高可信私有知识底座，既可作为独立受控知识工作台，
也可通过 Knowledge API（`/api/v1/retrieve`、`/api/v1/ask`）嵌入客服、售后、销售、研发协作、合规与运维等
“低容错、强权限、重版本治理”的业务系统。当前已超过 Demo，具备受控试点和小规模私有化交付基础；
不是对任意客户环境的 production-ready 或安全认证。默认一位客户一套独立实例，
Workspace 用于企业内部治理，不是公网共享多租户 SaaS。

当前发布为 [v0.3.5](https://github.com/codexlin/UnoRAG/releases/tag/v0.3.5)。
该版验收记录中，香港参考实例 `https://unorag.unobyte.dev` 安装了精确 `b70b954` 的四个签名镜像；这不是实时巡检结果。
本版三轮质量 **126/126**、多轮 **9/9**、浏览器 **300/300**，签名镜像完成新装、回滚和恢复验证。
部署保留既有生效文档版本，并新增反馈、授权历史追问、Excel 表格和 MinerU 图表裁剪能力。
后续源码或文档提交不会自动改变已部署版本。邮件策略仍在应用内配置，传输凭据只在服务器私有配置。

### 源码与发布的差别

- **已随本版发布**：反馈/Bad Case、scope 缓存、并发门、Markdown 与 Excel 表格、pg_trgm 目录候选、
  授权多轮记忆、同一生效代次的检索扩展和可选图表读取。`0033`/`0034`/`0035` 已迁移，存量不自动重索引。
- **v0.3.5 之后的源码演进（面向 `v0.4.0`）**：
  - 默认启用 Qdrant `lexical_v1 (modifier: "idf")` Sparse/RRF，移除应用层 10,000 条 BM25 回退，保留工作区独立开关与部署级关闭开关；自动模式按问题决定首轮是否重排。
  - 引入确定性纯 TS Token 估算与 `CHUNK_POLICY_VERSION = "v2"`（400 tokens / 60 overlap）、零额外模型成本的 `>40%` 表格自动 `table_heavy` 档位、按 Token 预算的父上下文扩展及按主体均衡配额的对比上下文裁剪（保留完整连续冲突摘录）。
  - 新增仅限 Admin/Editor（不含 `service_key`）的临时检索轨迹检查器（粗排 vs 精排差异、淘汰候选二次强权限校验、`no-store` 与绕过缓存、持久化维持 100% `metadata-only`）。
  - 精简部署环境变量模板并支持 `LLM_API_KEY` / `LLM_BASE_URL` / `UNORAG_BASE_URL` 标准别名；新增 `0036` 迁移支持工作区告警阈值热更新与独立 Hybrid/Rerank 控制；补充 Qdrant/Embedding 维度错配预检、模型历史长回复投影压缩、EN/ZH 双语界面与 4 套内置主题。
  - `#308` 阶段开发机基线（历史中间快照，非正式验收）：标准活库回归 `pnpm eval:live` 7/7 入库、35/36 正向（Recall@K/MRR 1.000、拒答 6/6、P95 9.62s）；外部 FinanceComplexQA 22 份 PDF / 135 题对比 ADR-0008 基线，语义准确率由 64.4%（已答 74.5%）提升至 65.7%（已答 75.2%），对比题回答率 +4.7pp、多跳推理 +3.7pp、P95 降低 1.28s。后续安全与质量收口见下节；正式发布验收仍按 [ADR-0008](./adr/0008-qdrant-server-side-sparse-rrf.md) 绑定 `v0.4.0` 签名镜像独立执行。
- **失败证据仍保留**：`v0.3.3` 三轮 **120/126**，两条首问误拒答；`v0.3.4` 浏览器 **298/300**，均未发布。
  `v0.3.5` 第一次浏览器全量的菜单时序超时也保留，另用仅测试同步修正的 [#286](https://github.com/codexlin/UnoRAG/pull/286)
  对同一签名镜像重跑 300/300，不改写初次结果。
- **尚未证明**：独立上手、客户容量和 COS 对象内容容灾。

### 当前安全与质量收口（`v0.4.0` 发版前开发机验证）

本轮在 `b796e18` 基础上通过 [#313](https://github.com/codexlin/UnoRAG/pull/313)–[#318](https://github.com/codexlin/UnoRAG/pull/318) 完成了面向全新部署的 5 域全量收口，覆盖 4/4 P0 阻断缺陷、15/15 P1 高优问题、8/9 P2 改进项及 `chat@1.17.0` 限定词回归：

- **安全与生命周期（#313, #316）**：修复撤权后回答交付、跨 Provider 凭据同源绑定、移除成员导致单人受限文档静默公开（含 ACL 投影、会话吊销与审计）、Cookie 写接口同源校验与改密限流、Service Key 空列表 fail-closed、自定义 `library_id` 切图外键错误、派发前取消任务饿死 DBOS 对账池及取消覆写 `deleting` 墓碑。
- **RAG 检索、表格与解析（#313, #317, #318）**：修复 `grounded_table_lookup` 触发 Judge 重试死循环、未重排时稀疏独有命中被丢弃、重排去重前截断回填低分候选、带单位表头（`万元`/`%`）10,000 倍放大与 JSON 过滤缩放、超大表格/代码 chunk 超限、XLSX 年份子表头误判、MinerU `section_path` 与精确 `record_id` 扩展、`ScopedRetrievalCache` 键漏项与降级污染，并在 `chat@1.17.0` 恢复并列指标限定词示例。
- **前端对比度、状态机与部署运维（#314, #315）**：修复 4 套内置主题明暗对比度至 WCAG AA（`>= 4.5:1`）、Ask 跨会话隔离与归档轨迹权限、前端 `health.recovery` 展示与双语补齐、Helm `dbos-worker` COS 配置与分角色 PG 授权、Compose `web`/`dbos-control` Qdrant 配置对齐、告警降级恢复邮件以及镜像发布前置 Trivy 扫描。

开发机本轮预检结果（尚未替代签名镜像正式发布验收）：
- **自动化验证**：`pnpm verify`、`pnpm test:fast`（1,611/1,611）、`pnpm test:contract`（46/46）、真实 PG/Qdrant/Redis 集成测试 `pnpm test:integration`（191/191）、实时 Compose 浏览器全量 E2E（148/148）与 `pilot-smoke.sh` 真实模型端到端冒烟全部通过。
- **标准活库真模型门禁（`pnpm eval:live`，`chat@1.17.0`）**：**PASS** —— 7/7 入库完成，正例 **36/36（100%）**，拒答 **6/6（100%）**，Fact Coverage / Document Recall@K / MRR 均为 **1.000**，Citation Precision **100.0%**，`cross_page_table` **6/6**，`low_contrast_scan` **5/5**，延迟 P50 / P95 为 **5.63s / 7.99s**。
- **待正式签名镜像验收**：发布 `v0.4.0` tag 构建四个签名镜像后，仍需对精确签名镜像独立补齐三轮稳定性、恢复演练与目标环境新装/升级验收并替换当前发布报告。

### `v0.4.1` 补丁收口（`#311`, `#320`–`#325`）

在 `v0.4.0` 基础上，已完成全部剩余审计项与全量活库压测暴露回归的修复收口：

- **部署级重排开关与策略并发控制（#320, #321）**：关闭 P2-4（新增 `TS_RETRIEVAL_RERANK_ALLOWED` 部署级开关、`PATCH /api/workspace/settings` 同源校验 + `policy_version` 乐观锁 `409` + 事务审计及双语 UI）；修复 200% 缩放下策略面板换行并对齐全量 Playwright（**324/324**）。
- **表格查找、派生计算与微 section 检索修复（#322, #323, #324）**：修复重复表头触发 `deriveGroundedTableLookup` `TypeError`（消除实测 9 道 HTTP `503`）；允许表格投影 chunk 挂载父 section 上下文并放宽派生计算题 `baseTopK >= 10`；新增同章/连续编号短微 section 检索期合并（免重入库立即生效）并在 MinerU 解析期推断扁平 `text_level: 1` 的多级标题层级。
- **评测成本控制与依赖维护（#311, #325）**：`run-hf-benchmark.ts` 默认入库超时提至 60 分钟且默认 fail-fast，新增 `--reuse-or-create`、`--only-ids` 与 `--only-failed-from` 支持零重入库和失败子集回归；同步合入 `tools/landing-video` Dependabot 更新（#311）。
- **开发机完整回归结果（未替代签名镜像正式发布验收）**：`pnpm verify`、`pnpm test:fast`（1,345/1,345）、`pnpm test:contract`（40/40，6 项本机无 `helm` 跳过，CI 全绿）、`pnpm test:integration`（192/192）、Playwright（324/324）、`pnpm eval:live`（正例 **36/36**、拒答 **6/6**）、`.unorag/acceptance`（证据冲突 **26/26**、多轮含 301s 过期 **9/9**）全部通过；外部 FinanceComplexQA 22 份 PDF / 135 题（含 `--semantic-judge`）实现 **0 HTTP 503 / 0 失败**，回答率 **88.1%**（+0.8pp）、文档召回 **87.3%**（+0.8pp）、MRR **0.869**（+0.008）、数值命中率 **58.3%**、综合事实命中率 **43.4%**（+0.5pp）、语义准确率 **65.3%**、拒答准确率 **94.1%**（+5.9pp）、P95 **19.8s**（-1.3s）。

### `v0.4.2` 首页动效与本地模型部署补丁（`#327`, `#328`）

- **本地模型与上手文档（#327, #328）**：在 `deploy/compose/docker-compose.yml` 补充 `host.docker.internal` 映射以直连宿主机 Ollama/vLLM，补齐中英 README、部署指南与 Helm 拆分密钥说明。
- **对外首页双语×浅深色动效升级**：重做 `tools/landing-video/` → `public/landing-media/` 全部 12 支循环片与 12 张 Poster（自托管 `Geist`/`Geist Mono`、扫描线引用核验、检索前 ACL 黑幕隔离、3D 文档行入槽与双状态表达、顺序阶段耗时瀑布），并精修首页章节/证据卡 `layoutId` 滑块、播放进度微条与连续滚动文案动效；已通过 `pnpm verify`、`pnpm test:fast`（1,345/1,345）及桌面/移动 `landing-page.spec.ts`（8/8）。

下表描述当前源码能力；线上可用范围仍以具体 Release 和部署清单为准。

## 已具备的闭环

| 领域 | 已实现 |
|---|---|
| 身份与权限 | 本地登录、首次改密、邀请注册、邮箱链接登录/重置、可撤销 Session、Workspace/角色、文档 ACL、Service Key、审计 |
| 文档治理 | 上传、替换、版本、重索引、删除；失败保留旧 active generation；DBOS 重试、取消和对账 |
| 文档理解 | TXT/Markdown/DOCX/XLSX/PDF，LiteParse/MinerU，Markdown 管道表、DocumentIR/TableIR，Token 感知 `v2` 切分与 `>40%` 表格自动 `table_heavy`、多粒度索引及默认关闭的条件式检索上下文增强 |
| 检索问答 | 作用域强制过滤、默认启用 Qdrant 服务端命名 Dense + `lexical_v1 (modifier: "idf")` Sparse/RRF、重排、改写、证据裁决、按主体均衡配额的对比上下文、拒答、引用、确定性表格执行与 SSE；Admin/Editor 临时检索轨迹检查器；pg_trgm 授权文档目录候选检索 |
| 会话 | 带来源授权的短期记忆、实体追问、有限期歧义澄清、归档和继续对话；模型上下文压缩长回复，归档保留原文和来源 |
| 运维预检 | 健康接口和运行中心校验现有 Qdrant 集合的向量维度、距离、`lexical_v1` IDF 配置及载荷索引，按异常类型给出恢复提示 |
| 产品界面 | shadcn/Base UI、AI Elements、EN/ZH 双语、Vercel/Claude/Violet Bloom/Modern Minimal 4 套主题、可调圆角、响应式工作台与设置分区；引用/版本/执行链路一致的阅读入口 |
| 运维交付 | 原生阶段瀑布/请求诊断/工作区可配告警阈值、工作区邮件策略及持久化投递、精简环境变量与标准别名、可选 OTel/Langfuse、签名镜像、安装升级、备份与恢复工具 |
| 反馈闭环 | Ask 赞/踩与原因标签、运行中心处理状态、待人工补全的黄金集样本骨架；不是自动采纳用户反馈为真值 |

实现与边界详见 [架构](./ARCHITECTURE.md)；安装见 [部署指南](./DEPLOYMENT.md)，问题排查见 [运维指南](./OPERATIONS.md)。

## 验证到哪里

| 当前版本验收 | 结果 |
|---|---|
| 发布提交 | 精确 main CI 通过，快测 1420/1420、真实 PG/Qdrant/Redis 集成 169/169、契约 37/37，均 0 skip |
| 香港交付 | 四镜像扫描/验签、五项备份校验、排空、`0033–0035` 迁移及真实业务冒烟通过；27 个生效版本映射不变 |
| 标准稳定性 | 7/7 文件入库，三轮 126/126、最高 P95 9.44 秒；多轮 9/9 含真实 301 秒过期等待 |
| 新能力验证 | 双工作表 XLSX 真实入库与两道问答正确引用；真实 MinerU 裁剪支持授权图片读取 |
| 恢复与隔离 | 活跃任务时拒绝切换，旧任务续跑；真实故障注入、备份恢复、恢复后反馈与新上传；隔离前后各 29/29 |
| 浏览器 | 同一签名镜像，桌面/移动全量重跑 300/300，零重试；使用菜单同步修正，不改镜像或测试断言 |
| 最终巡检 | dead/stuck、清理错误、pending ACL 均为 0；原有文档未重建或重索引 |

完整证据：[v0.3.5 发布验收](./evidence/2026-11-20-v0.3.5-release.md)。
文件是仓库 fixture，三轮重复问答不是更多独立题目，抽查不等于独立人工签字。
移动端使用浏览器模拟。客户容量、安全、网络及 RPO/RTO 仍须单独验收。
历史失败由 [历史证据入口](./evidence/README.md#历史证据) 保留，不被新 PASS 改写。

## 已知限制

- 片段选择协议消除了模型抄写摘录的依赖，不保证任意问题都能正确裁决。历史故障的原模型摘录未保存，
  不能还原具体字符差异；三轮 fixture 和代理复核不是对未知客户语料的质量保证。
- [#241](https://github.com/codexlin/UnoRAG/issues/241) 已完成关联调查：测试 routing 禁用缓存、累计预算放大已证实；
  服务端原有 gzip/immutable 正常。外部传输的具体历史根因仍未知，完整功能通过不是客户端网络 SLA。
- 少量回答只有来源列表而没有句内引用编号；机器 citation precision 不代表逐事实锚点覆盖。
- [#250](https://github.com/codexlin/UnoRAG/issues/250) 的下限限定修复已发布，原始失败保留。
  本版抽查仍有一条预算回答省略「约」；若改变金额、资格或决策边界仍为阻断项。
- 保存的评测 citation 未覆盖全部标题/heading 元数据；原文件支持答案不等于报告能证明所有运行时身份上下文。
- [#193](https://github.com/codexlin/UnoRAG/issues/193)：历史单次 Qdrant 故障根因未知，等待新的关联证据。
- [#202](https://github.com/codexlin/UnoRAG/issues/202)：可选离线 Ragas/DiskCache advisory；该 Python 环境不在四个产品镜像内。
- COS sidecar 只有对象引用，不是文件内容备份；尚未据此证明对象误删或桶级恢复能力。
- [#229](https://github.com/codexlin/UnoRAG/issues/229)：总预算耗尽不再自动重提 staging，补丁已部署。
  本轮标准及扩展矩阵入库通过；开发机首次验收曾轮询超时，不能据服务端最终成功推断网络根因。
  这不解释历史长等待的服务商内部根因，也不证明未来延迟保证或跨重启任务去重；原失败报告不改写。
- 账号邮件使用有界请求/Next `after`，不是持久化账号邮件队列；进程中断可能需要重新申请。告警投递另有持久化重试。
- 冲突核验只覆盖事实/追问的已授权召回证据，不是全库矛盾检测；表格、比较、汇总和目录不运行这一步。
- 完整标题目录有界；超过 500 份授权文档时按问题检索至多 500 份身份候选，不将候选误称为完整目录；匹配截断或无法证明完整性仍失败关闭。
- 图文 PDF 目前证明正文/图注恢复，不代表 ChartIR 或独立图表数值理解。
- 没有可交付 OIDC/SSO、SCIM/用户组管理 UI、稳定公共文档生命周期 API；Helm 仍是 starter。
- PostgreSQL 使用作用域查询、约束及分离运行角色，未启用 RLS；Redis 模型并发门只限制接入该门的 Web 调用，
  不是 Web/Worker 共用的 Provider RPM/TPM 配额管理。Redis 故障默认回退本地门，严格模式需显式配置。

## 下一步与演进路线

当前优先观察 v0.3.5 的真实使用质量、上游解析延迟与运维数据。
不同时启动 Agent、GraphRAG、OIDC/SSO 或完整 Ops Stack。

演进遵循**内核红线不变、外围能力按客户堵点分阶段开放**的原则：长期保持 TypeScript 控制面与 DBOS
唯一事实源（[ADR-0005](./adr/0005-typescript-core-runtime.md)）、Apache-2.0 单一完整开源发行（[ADR-0007](./adr/0007-fully-open-source-product-and-services.md)）、
Staging/Active 原子切换、检索前置强权限与黄金集稳定性门禁，不因功能扩展降低质量与安全阈值。

### 当前：交付与试点

1. 由未参与开发的人按文档完成安装、排错和升级，并补齐 COS 对象字节的独立备份恢复。
2. 以获授权材料和留出题验证实际解决率；反馈导出须人工核对来源和补全后才进入黄金集。
3. 保持每版重新绑定镜像的质量、多轮、隔离和恢复验收，继续跟踪上游等待（#229）与近似数值表述。

### 后续：按实际需求扩展

1. **大规模语料容量验收**：已全面切换至 Qdrant 服务端命名 Dense + `lexical_v1 (modifier: "idf")` Sparse/RRF（[ADR-0008](./adr/0008-qdrant-server-side-sparse-rrf.md) 已采纳，移除 10,000 条应用层 BM25 语料回退），后续在百万级客户语料上继续验证 Qdrant 稀疏索引与 PostgreSQL `pg_trgm` 授权目录检索的延迟与容量边界。
2. **稳定文档生命周期 Public API 与外置连接器**：开放幂等上传/替换/删除与状态查询公共 API，以独立外置 Sync Adapter 对接飞书、钉钉、Confluence、SharePoint 或对象存储事件，不将第三方 SDK 耦合进 DBOS 核心。
3. **解析增强效果验收**：对默认关闭的条件式 Contextual Retrieval，在获授权的无标题层级/OCR 降级语料上验证召回质量与成本，验收通过后再决定启用范围。

以下是未排期方向，不是当前发布前置条件：

1. **有界 Tool-Use Harness**：逐步收敛硬编码正则路由补丁，在严格步数预算和 `AuthorizedScope` 约束下，按需支持超限附件的只读大表沙箱执行、图表按需 VLM 数值读数（Chart/Figure），以及客户声明式只读业务 API 联动。
2. **轻量跨文档关系索引**：基于 PG 已提取的文号、项目编号与主体构建受控关系索引支持二跳扩召回，替代高成本黑盒全库 GraphRAG。
3. **纵深合规底座**：按客户合规要求提供可选 PII 识别脱敏拦截、PostgreSQL RLS 纵深加固及轻量在线试用隔离能力。
4. **企业身份对接**：只有试点明确需要时再基于 `OidcIdentityProvider` 接入 OIDC/SSO 与组同步；
   现有本地账号、邀请、角色和文档 ACL 不因此被描述为尚不可用。

### 长期克制（明确不做）

- 不做公网商业 SaaS 多租户计费与开源功能墙（遵守 [ADR-0007](./adr/0007-fully-open-source-product-and-services.md)）。
- 不为“目录整齐”拆分多语言产品核心后端或引入无真实构建边界的空包 monorepo。
- 不在未验证质量、权限与延迟收益前引入无边界自由 Agent 循环或默认捆绑重型 Ops Stack。

## 维护约定

每次行为变更同步修改对应指南；正式发布后替换当前验收报告，并将旧报告链接到不可变 Git 提交或 Release。
不把全部实验日志、测试数量和候选状态重复追加到本文。文档入口统一在 [docs/README.md](./README.md)。
