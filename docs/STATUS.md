# UnoRAG 当前状态

> 更新日期：2026-11-27。本文只维护当前成熟度、已知限制和下一步；架构细节见 [ARCHITECTURE](./ARCHITECTURE.md)，逐版结果见 [验收索引](./evidence/README.md)。

## 当前结论

UnoRAG 是 Apache-2.0 开源、TypeScript-only 的企业级高可信私有知识底座，既可作为独立受控知识工作台，
也可通过 Knowledge API（`/api/v1/retrieve`、`/api/v1/ask`）嵌入客服、售后、销售、研发协作、合规与运维等
“低容错、强权限、重版本治理”的业务系统。当前已超过 Demo，具备受控试点和小规模私有化交付基础；
不是对任意客户环境的 production-ready 或安全认证。默认一位客户一套独立实例，
Workspace 用于企业内部治理，不是公网共享多租户 SaaS。

- **最新发布版本**：[v0.4.13](https://github.com/codexlin/UnoRAG/releases/tag/v0.4.13)（各 `v0.4.x` 演进与 CI/开发机回归见下方逐版记录；参考实例部署状态以审批发布记录为准）。
- **最近完成全套签名镜像验收基线**：[v0.3.5](https://github.com/codexlin/UnoRAG/releases/tag/v0.3.5)（[v0.3.5 发布验收](./evidence/2026-11-20-v0.3.5-release.md)，三轮质量 **126/126**、多轮 **9/9**、浏览器 **300/300**，签名镜像完成新装、回滚和恢复验证；这不是实时巡检结果，且 `v0.4.x` 尚未替换该全套验收报告）。
部署保留既有生效文档版本，并已逐步补充 Qdrant 服务端混合检索、统一自动精排、Owner 在线模型管理、极薄双语路由、选择性冲突核验及 COS 对象字节级容灾备份。
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

### `v0.4.2` 首页动效与本地模型部署补丁（`#327`, `#328`, `#329`）

- **本地模型与上手文档（#327, #328）**：在 `deploy/compose/docker-compose.yml` 补充 `host.docker.internal` 映射以直连宿主机 Ollama/vLLM，补齐中英 README、部署指南与 Helm 拆分密钥说明。
- **对外首页双语×浅深色动效升级（#329）**：重做 `tools/landing-video/` → `public/landing-media/` 全部 12 支循环片与 12 张 Poster（自托管 `Geist`/`Geist Mono`、扫描线引用核验、检索前 ACL 黑幕隔离、3D 文档行入槽与双状态表达、顺序阶段耗时瀑布），并精修首页章节/证据卡 `layoutId` 滑块、播放进度微条与连续滚动文案动效；已通过 `pnpm verify`、`pnpm test:fast`（1,345/1,345）及桌面/移动 `landing-page.spec.ts`（8/8）。

### `v0.4.3` 审批门禁发布流与 6 位邮箱验证码（`#330`, `#331`）

- **审批门禁自动化部署与安全清理（#330）**：新增 `.github/workflows/deploy.yml`（预检 `SHA256SUMS` 与 Cosign v3 签名，经 GitHub Environment 人工审批后执行 `remote-deploy.sh` 并校验 `/api/rag/health` 版本与 digest），为 `backup.sh` 增加 `--retain N` 校验后备份轮转，新增 `prune-release-images.sh` 与 `upgrade.sh --prune-old-images` 安全清理旧镜像（保留现网与回滚双版本、禁用 `--force`、不触碰卷）。
- **跨设备 6 位邮箱验证码（OTP）与认证表单修复（#331）**：新增 Drizzle 迁移 `0037_account_email_otp.sql`，邮箱登录与重置密码邮件同时提供 6 位一次性验证码（行级 `token_hash` 加盐 SHA-256、与链接互斥单次消费、5 次错误作废、Redis 账号级消费限流）与同设备链接；前端接入官方 shadcn `base-nova` `InputOTP` 并修复认证表单 64px 空白断层（60/60 Playwright 桌面+移动端与 CI 6/6 全绿）。

### `v0.4.4` 登录直跳优化与部署收口修复（`#333`, `#334`）

- **认证边界直跳 `/app/ask` 与进入工作区加载态（#334）**：登录、邮箱验证登录、首次改密与邀请加入完成后直接通过硬跳转进入 `/app/ask`（保留 `/app` 书签兜底），消除 `/app` → `/app/ask` 多余跳转及 `router.replace()` + `router.refresh()` 竞态；跳转期间保持控件禁用并显示“正在进入工作区…”加载反馈（桌面/移动 Playwright 认证回归 **82/82** 全绿）。
- **自动化部署巡检参数修复（#333）**：修复 `deploy/compose/scripts/remote-deploy.sh` 调用 `inspect-lifecycle` 时覆写 Compose `command` 导致退出码 `9` 的问题，并补齐自动化测试回归。

### `v0.4.5` 全站悬浮滚动条与零布局抖动升级（`#336`）

- **根文档零占位悬浮滚动条与零抖动弹窗锁滚（#336）**：新增 `WindowScrollbar` 挂载至根布局并隐藏浏览器原生 `html` 占位滚动条（同时移除触发 macOS 降级的全局 `*::-webkit-scrollbar` 样式），确保 `window.innerWidth === documentElement.clientWidth` 恒成立，从而让 Base UI `useScrollLock` 始终走零偏移悬浮路径，消除打开 Sheet/Dialog/Select/Popover 时的横向抖动。
- **全工作台 Overlay `ScrollArea` 与消息列表组合（#336）**：升级 `src/components/ui/scroll-area.tsx`（接入 `ScrollAreaPrimitive.Content`、`no-scrollbar` 防首屏闪烁、悬停/滚动自动淡入淡出及双向滚动支持），将 `MessageScroller` 组合至 `@base-ui/react/scroll-area` 并全量迁移工作台主滚动区、设置页、运行中心、审计面板、抽屉/详情 Sheet、主题切换弹窗及双轴 `LedgerTable`（保留粘性表头）；新增 Playwright 零抖动回归测试（桌面/移动 **92/92** 与 `pnpm test:fast` **1,346/1,346** 全绿）。

### `v0.4.6` 工具链与构建安全收口（`#338`）

- **pnpm 10 工具链与构建脚本供应链收口（#338）**：将根 `package.json`、`deploy/docker/migrator/package.json` 与 `deploy/docker/web.Dockerfile` 4 个 Corepack 阶段的 pnpm 从 9.7.1 升级至 10.34.9，并同步 `docs/DEVELOPMENT.md`；显式配置 `onlyBuiltDependencies: ["esbuild"]` 与 `ignoredBuiltDependencies: ["protobufjs"]`，保持 `pnpm-lock.yaml` 零差异。
- **mise 自动切换与 CI 单一事实源（#338）**：新增根 `mise.toml`（`node = "22"`、`pnpm = "10.34.9"`）自动切换本地工具链；移除 `.github/workflows/ci.yml` 中重复硬编码的 `version`，让 `pnpm/action-setup@v6` 直接读取 `packageManager`。

### `v0.4.7` 统一自动精排、Owner 在线模型管理与 3 字段问答策略（`#340`）

- **统一 `auto` 精排、`sparse-only` 自动升级与主流 `/rerank` 兼容（#340）**：将 `auto` 重排触发统一覆盖至中英精确编号、多轮改写、`compare`、多方面事实、派生计算与证据不足重试（同时确保 `tableOnly` 确定性表格探针不被误重排）；当混合检索召回 `sparse-only`（`dense_score=null`）候选且允许重排时（含单条命中）自动升级 Cross-Encoder 精排以统一分数尺度；兼容单数 `/rerank` 路径（vLLM / SiliconFlow / Xinference / Jina / Cohere / Voyage）、Voyage `data[]` 与 `top_k` 参数、raw-logit 排序前不提前截断，以及可选 `embedDocumentChunks` 端口。
- **Owner 级「模型与供应商」在线管理与部署锁定模式（#340）**：新增迁移 `0038_organization_model_settings.sql` 与最小权限角色隔离（`unorag_web` 仅 `SELECT/INSERT/UPDATE`、`unorag_worker` 零访问权限）；新增仅限组织 Owner 的 `/app/settings#models` 页面与 `/api/organization/model-settings`（含 `/test`）接口，支持免重启在线热切换 Chat / Judge / Rerank / VLM、AES-256-GCM（HKDF + 组织/槽位 AAD）只写加密与 `MODEL_SETTINGS_ENCRYPTION_KEY_PREVIOUS` 零停机轮换、实时连通性/`json_schema`/`/rerank`/视觉探测、SSRF/DNS/重定向与密钥-端点同源绑定防护，以及金融/政企 `MODEL_SETTINGS_LOCKED=true` 部署级锁定模式；Embedding 保持部署级只读契约。
- **工作区「问答策略」收口与环境变量清理（#340）**：将 6 个历史问答策略字段收敛为 3 个清晰字段（`answer_profile`、`reranking: auto | on | off`、`session_memory_enabled`），工作区层默认常开 Qdrant 混合检索（仅保留部署级 `TS_RETRIEVAL_HYBRID_ENABLED=false`，已补充至 ADR-0008）；读时平滑投影历史行、写时严格拒绝旧字段；彻底移除冗余 `TS_RETRIEVAL_RERANK_ENABLED`，仅保留 `TS_RETRIEVAL_RERANK_ALLOWED`。
- **开发机验证结果（未替代签名镜像正式发布验收与大基准重跑）**：CI 6/6 全绿（含 `ci/web` Postgres/Helm/Playwright、`ci/secrets`、`ci/docker-build`、`ci/offline-evaluation`），本地快测 `ts-core` **1,363/1,363 PASS**；实连 Mac mini（PG 17 + Redis 7 + Qdrant v1.19.0）+ 真实 DashScope 完成 26/26 项功能端到端 QA（`0038` 迁移、3 字段策略、Chat/Rerank 实时探测、SSRF 拦截、审计日志、文档上传索引与 7 轮流式问答/拒答/`auto` vs `off` 实测全部通过；42 题 `pnpm eval:live` 与 135 题 FinanceComplexQA 基准尚未在本提交重跑）。

### `v0.4.8` 极薄前置路由、证据驱动表格升级与 Judge 缺口定向补查（`#342`）

- **极薄前置路由与中英双语意图覆盖（#342）**：引入跨语料 `thinPreRetrievalRoute`（`src/core/ask-graph/nodes/thin-router.ts`），毫秒级处理中英双语 `compare`/`summary`/显式表格/追问与英文 `Compare A and B on ...` 子问扇出，放行短领域缩略词（`SLA`/`ROI?`/`GDPR` 等）直通检索而不误判完整英文问句；收紧 `SELF_CONTAINED_RETRIEVAL_PATTERN`，并预留默认关闭的 Fail-Open 灰区路由端口（`ASK_GRAY_ZONE_ROUTER_ENABLED=true`，1.5s 超时与 `>=0.6` 置信度门控）。
- **证据驱动表格升级与极值实体补全（#342）**：对隐式最值/均值/合计/筛选/计数/序数问句不再靠检索前猜意图，而是在统一召回命中真实 `table_id` 后，严格限定 `(doc_id, document_version_id, table_id)` 做本地 `<1ms` 干跑验证通过才升级为确定性表格执行（`evidence_driven_table_operation`），否则无损回退正文链路；单极值 `min`/`max` 结果同步附带 `describeRow(...)` 行实体描述（含并列极值行）。
- **Judge `missing_query` 定向补查、隐私脱敏与运行时加固（#342）**：注册 `judge@1.17.0` 并在首轮（`attempts<=1`）缺口时输出受限短检索词 `missing_query` 发起定向补查（`retry_strategy: "judge_missing_query"`），合并首轮已授权证据与文档身份并拦截同 `doc_id` 跨 generation 混排；严格维持 `metadata-only`，不将原始 `missing_query` 写入诊断表或公开调试字段，仅持久化脱敏枚举码；同时收口最终轮 Judge 矛盾输出重试与 `retry` 规范化、Qdrant 幂等读（`query`/`scroll`）对 `UND_ERR_SOCKET`/`ECONNRESET`/`EPIPE` 的单次快速重试，以及多轮追问中英空格容错原文主语回溯。
- **开发机 192 题真模型全量实测结果（连 Mac mini PG 17 + Redis 7 + Qdrant v1.19.0 + 真实 DashScope / 302.AI MinerU，未替代签名镜像正式发布验收）**：
  - **自动化验证**：PR #342 CI 6/6 全绿（含真实 PG/Qdrant/Redis 集成测试 193/193 含单次断连自动恢复与连续断连诊断验证）、本地 `pnpm verify` 与 `pnpm test:ts-core` **1,404/1,404 PASS**。
  - **外部 `FinanceComplexQA`（22 份金融 PDF / 135 题，`--semantic-judge`，对比 `v0.4.1` 基线）**：回答率 **`91.5%`**（108/118，**+3.4pp**）、文档召回 **`90.7%`**（**+3.4pp**）、MRR **`0.898`**（**+0.029**）、语义准确率 **`68.2%`**（**+2.9pp**，已作答正确率 **`74.5%`**；`Comparison` 达 **`85.7%`**）、库外不可答拒答 **`10/10 (100%)`**（总体拒答 `15/17`，2 题系跨文档真实召回/诚实部分作答）、P50/P95 `14.91s / 23.32s`；期间在真实金融语料上命中 2 次证据驱动表格升级（`1.73s` / `3.23s`）与 4 次 `judge_missing_query` 定向补查（2 次成功挽回作答），并在测试后针对抓出的 1 次终轮 Judge 矛盾与 1 次局域网 `UND_ERR_SOCKET` 偶发 503 完成加固合入。
  - **标准活库 `pnpm eval:live`（42 题）**：Fact Coverage **`1.000`**、Doc Recall@K / MRR **`1.000 / 1.000`**、Citation Precision **`100.0%`**、拒答 **`6/6 (100%)`**、跨页表 **`6/6`**、低对比度扫描 **`5/5`**、确定性表格 P50 **`998ms`**（正例 35/36，唯一未过项 `9640cadfd327022e` 事实与引用 100%，系 `qwen-plus` 冲突检测随机误报）；**EN/ZH 路由与定点重试 HTTP 专项（15 场景）** 15/15 HTTP 200，Mac mini `app.ask_run_stages` 全量 192 次运行审计确认原始 `missing_query` 泄漏数为 **`0`**。

### `v0.4.9` 选择性冲突核验默认化、提示词校准、离线评测与部署加固（`#344`）

- **默认启用选择性冲突核验（#344）**：在运行时、`deploy/compose/docker-compose.yml`、`deploy/config/runtime.advanced.env.example` 与 `docs/ARCHITECTURE.md` 统一将 `ASK_CONFLICT_CHECK_MODE` 默认值切换为 `selective`（保留 `always` 显式回切），扩展中英单文档主题白名单同时严格守住规则、日期、门槛、数值、权限、比较与跨文档冲突核验红线。
- **提示词校准（`chat@1.18.0`、`judge@1.18.0`、`conflict@2.5.0`、`conflict_review@1.1.0`）**：补齐假设目标值代入、静态市净率 PB 与跨十进制单位统一换算后再加总规则，修复短文档摘要因缺少独立总则段导致的过度拒答，并校准空白签署占位符与一般法/专项条款冲突边界。
- **离线评测安全加固与自动化部署 SSH 韧性（#344, #202）**：将 `scripts/evaluation` 中 `ragas` 升级至 `0.4.4` 并重锁 `uv.lock`（修复 CVE-2026-6587 / Dependabot `#69`、`#72`），在 `ragas_offline.py` 导入 `ragas` 前运行时阻断 `diskcache` 各类持久化缓存实例化（中和上游尚未修复的 CVE-2025-69872 / `#70`，4 个产品镜像本身不含 Python/Ragas）；为 `.github/workflows/deploy.yml` 补充 `ConnectTimeout 30`、`ConnectionAttempts 3` 及仅限幂等握手/上传的 3 次重试（不重试远端升级命令），消除经 ProxyJump 的瞬态 banner 超时。
- **开发机真模型复测结果（连 Mac mini PG 17 + Redis 7 + Qdrant v1.19.0 + 真实 DashScope，未替代签名镜像正式发布验收）**：
  - **自动化与冲突控制门禁**：PR #344 CI 6/6 全绿（含 `ci/offline-evaluation` 16/16 Python 单测、`ci/web` Postgres/Helm/Playwright、`ci/docker-build`、`ci/secrets`），本地 `pnpm verify`、`pnpm test:ts-core`（**1,404/1,404**）、`pnpm test:contract`（41/41）与 2 轮真实 DashScope 冲突控制套件（`scripts/acceptance/evidence-conflicts.ts`，**26/26 PASS**）全部通过。
  - **外部 `FinanceComplexQA`（22 份金融 PDF / 135 题，`--semantic-judge`，零重入库对比 `v0.4.8`）**：回答率升至 **`93.2%`**（110/118，**+1.7pp**）、文档召回 **`92.4%`**（**+1.7pp**）、MRR **`0.915`**（**+0.017**）、数值/术语/综合命中率全面创新高（**`58.7%` / `36.0%` / `45.2%`**，综合 **+1.8pp**）、库外拒答 **`10/10 (100%)`**、冲突误报 **`0`**（`indCN_00505`、`finreport_00175`、`finreport_00251` 均已修复）；`selective` 模式将串行 `conflict` 调用由 108 次压降至 **66 次（-38.9%）**、`conflict` Token 减少 **223k（-36.3%）**、总 Token 下降 **13.3%**，`judge` 阶段 P50 降低 **1.00s**（`5.55s → 4.54s`），基准端到端 P50 降至 **`14.39s`**（服务端 `app.ask_runs` P95 **`22.94s`**），`app.ask_run_stages` 原始 `missing_query` 泄漏数为 **`0`**。
  - **标准活库 `pnpm eval:live`（42 题）与 EN/ZH 15 场景**：`eval:live` Fact Coverage / Doc Recall@K / MRR / Citation Precision 均为 **100%**、拒答 **6/6**、`cross_page_table` **6/6**、`low_contrast_scan` **5/5**、`e2ddb00fe88cf0e2` 通过（正例 35/36，`9640cadfd327022e` 事实与引用 100% 但仍偶发 `qwen-plus` 冲突误报）；15 场景专项 15/15 HTTP 200 且短文档摘要 `S06` 过度拒答已修复。

### `v0.4.10` COS 对象字节级容灾与离线评测依赖清零（`#346`, `#202`）

- **COS 对象字节级备份与 SHA-256 校验恢复（#346）**：新增 `scripts/cos-object-backup.mjs` 并打入 `ops` 镜像及 Compose `profiles: ["ops"]`（`cos-object-backup` 服务）；`backup.sh --include-cos-objects`（或 `UNORAG_BACKUP_COS_OBJECTS=true`）按 PostgreSQL `app.document_versions` 与 `app.document_figure_assets` 引用拉取全部 COS 原文与图表裁剪字节、生成 `documents.cos.tgz` 与每对象 `COS_OBJECTS.sha256` 并纳入 `MANIFEST.txt` / `CHECKSUMS.sha256`（默认保持升级维护窗短小）；`restore.sh` 自动先做全量 SHA-256 预检（篡改或缺失 archive 直接 fail-closed 不写入），通过后以 `ACL=private` 写回 COS 并校验远端 `Content-Length`。
- **离线评测彻底移除 `diskcache` 并关闭 `#202`（#346）**：通过 `scripts/evaluation/pyproject.toml` 的 `[tool.uv].exclude-dependencies = ["diskcache"]` 将传递依赖 `diskcache v5.6.3`（CVE-2025-69872）彻底移出 `scripts/evaluation/uv.lock`，并在 `ragas_offline.py` 导入前注入 fail-closed 桩模块；`ci/offline-evaluation` 16/16 单测 26 秒全绿，Issue `#202` 已正式关闭。
- **验证结果（未替代 `linux/amd64` 独立候选环境的签名镜像全量发布验收）**：PR #346 CI 6/6 全绿（含 `ci/web`、`ci/docker-build`、`ci/offline-evaluation`、`ci/secrets`），新增 `tests/cos-object-backup.test.mjs`（5/5 PASS）与 `tests/deploy-automation.test.mjs`（6/6 PASS）；同步在真实 DashScope 实测 `JUDGE_MODEL=qwen-flash` 冲突控制套件仅 21/26 FAIL（漏判 `explicit-precedence` / `explicit-clause`），确认保持 `qwen-plus` 默认 Judge 守住 26/26 冲突红线。

### `v0.4.13` 归档未关联文库与历史删库筛选代理修复

- **修复 `/api/rag/v1/threads` 代理层误拦 `library_id=__unlinked__` / `all` / 历史已删文库筛选**：在 `src/lib/server/rag-permissions.mjs` 新增 `requiresAuthorizedLibraryPrecheck` 并在 `src/lib/server/rag-proxy.ts` 仅对 `GET`/`HEAD /v1/threads` 跳过活跃文库预检（`ConversationRepository` 仍严格按 `organization_id + workspace_id + owner_principal_id` 隔离），同时保持 `POST /v1/threads`、`/v1/retrieve`、`/v1/ask` 与文档下载的 fail-closed `404` 校验，并补齐单测与真实 PostgreSQL `proxyRagRequest` 集成测试。

### `v0.4.12` 撤权一致性、解析器内存/脱敏加固、服务端分页与基础镜像安全补丁（`#348`, `#349`, `#350`）

- **说明**：`v0.4.11` 标签因推送前 Trivy 镜像扫描检出 Debian Bookworm `linux-pam` 安全漏洞（`CVE-2025-6020`，`1.5.2-6+deb12u2` → `1.5.2-6+deb12u3`）被阻断，未推送镜像亦未发布 GitHub Release（标签保持不可变）；本版补充 `deploy/docker/web.Dockerfile` 全部运行时阶段 Debian 安全升级后正式发布。
- **基础镜像安全更新（`CVE-2025-6020`）**：在 `deploy/docker/web.Dockerfile` 的 `runtime-deps`（`ops`/`worker`）、`migrator` 与 `runner`（`web`）阶段引导修补 APT 后执行 `DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends`，将 `linux-pam` 等系统包升级至最新 Debian Bookworm 安全版本。

- **Retrieve 撤权后缓存与交付复核（#348）**：`DrizzleActiveGenerationResolver` 将生效文档 `generationId:aclFingerprint` 摘要作为 `aclRevision` 绑定进 `ScopedRetrievalCache` 键，原地 ACL 投影后旧缓存立即失效；`executeNativeRetrieval` 交付前补齐身份、文库及批量活跃版本引用复核（覆盖工作台与公网 Knowledge API v1）。
- **解析异常脱敏与 PDF 持续入库内存上限（#348, #350）**：移除 `HttpParserProvider` 对上游错误正文的拼接、修复 `src/worker/errors.ts` 脱敏正则并对外部解析 `error_code` 实施封闭内部枚举映射；`LiteParseProvider` 与同步 `MinerUProvider` 读后立即释放正文载荷并施加 TTL/条数/字节上限，同时区分“等待首次交付”与“已交付可回收”，避免单份大文档在首读前自淘汰。
- **COS 流式预检与流式恢复（#348）**：`scripts/cos-object-backup.mjs` 改为第一遍流式计算全量 SHA-256（零内存缓冲归档），第二遍按限并发 `createReadStream` 逐对象写回 COS。
- **归档与文档台账服务端分页/搜索及按需详情（#349, #350）**：会话归档升级为通配符转义服务端标题搜索、筛库与保留 PostgreSQL 微秒精度的 keyset 游标分页（含 `limit=200` 的 `+1` 前瞻），突破最近 40 条限制；文档台账升级为复用 `documents_name_trgm_idx` 的服务端分页/搜索/任务筛选并跳过列表 JSONB `parser_report` 读取，详情抽屉按需拉取受 ACL 保护的单文档接口，Ask 示例与后台轮询改走轻量拉取。
- **验证结果（未替代 `linux/amd64` 独立候选环境的签名镜像全量发布验收）**：PR #348、#349、#350 均通过全部 6 项 CI（含真实 PostgreSQL 17 集成测试 `conversations-postgres` 与 `document-acl-routes-postgres`、`ci/secrets`、`ci/docker-build`、`ci/offline-evaluation`）。

下表描述当前源码能力；线上可用范围仍以具体 Release 和部署清单为准。

## 已具备的闭环

| 领域 | 已实现 |
|---|---|
| 身份与权限 | 本地登录、首次改密、邀请注册、邮箱链接登录/重置、可撤销 Session、Workspace/角色、文档 ACL、Service Key、审计 |
| 文档治理 | 上传、替换、版本、重索引、删除；失败保留旧 active generation；DBOS 重试、取消和对账 |
| 文档理解 | TXT/Markdown/DOCX/XLSX/PDF，LiteParse/MinerU，Markdown 管道表、DocumentIR/TableIR，Token 感知 `v2` 切分与 `>40%` 表格自动 `table_heavy`、多粒度索引及默认关闭的条件式检索上下文增强 |
| 检索问答 | 作用域强制过滤、极薄前置双语路由（含可选灰区 Fail-Open 端口）、云端默认 DashScope 原生 `qwen3.7-text-embedding`（`dense&sparse` → Qdrant `sparse_v1 (modifier: "none")` + RRF，含幂等读单次 socket 断连自愈）与私有化推荐 Ollama `bge-m3` 自动纯 Dense 模式（[ADR-0009](./adr/0009-provider-sparse-and-ollama-bge.md)）、统一 `auto`/`on`/`off` 精排（默认 `qwen3.7-text-rerank`，含 `sparse-only` 自动升级）、`qwen3.7-flash` 默认关闭思考模式（`enable_thinking: false`）、证据驱动确定性表格升级与极值实体保留、Judge 缺口定向补查（`missing_query` + 首轮授权证据留存）、冲突核验、按主体均衡配额的对比上下文、拒答、引用与 SSE；Admin/Editor 临时检索轨迹检查器；pg_trgm 授权文档目录候选检索 |
| 模型治理 | Owner 级在线切换 Chat / Judge / Rerank / VLM（AES-256-GCM 只写加密、实时连通性/`json_schema`/`/rerank`/视觉探测、SSRF 与密钥-端点绑定防护）、Embedding 部署级只读锁定，以及 `MODEL_SETTINGS_LOCKED=true` 纯环境变量锁定模式 |
| 会话 | 带来源授权的短期记忆、实体追问、有限期歧义澄清、归档和继续对话；模型上下文压缩长回复，归档保留原文和来源 |
| 运维预检 | 健康接口和运行中心按当前 Embedding Provider 能力校验 Qdrant 集合的向量维度、距离、`sparse_v1 (modifier: "none")`（或纯 Dense 契约）及载荷索引，按异常类型给出恢复提示 |
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
- [#202](https://github.com/codexlin/UnoRAG/issues/202)：可选离线 Ragas 评测环境已升级至 `ragas==0.4.4`（修复 CVE-2026-6587）并通过 `[tool.uv].exclude-dependencies` 将传递依赖 `diskcache` 彻底移出 `scripts/evaluation/uv.lock` 同时在运行时安装 fail-closed 桩模块阻断实例化；该 Python 环境不在四个产品镜像内。
- COS 备份默认记录对象边界以缩短升级维护窗；已内置 `--include-cos-objects`（`cos-object-backup`）提供按 PG 引用逐对象 SHA-256 校验的离线字节备份与恢复能力，生产环境大桶跨地域复制与 RPO/RTO 仍需按客户规模实测验收。
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

1. **大规模语料容量验收**：已按 [ADR-0009](./adr/0009-provider-sparse-and-ollama-bge.md) 移除手写 `lexical_v1` 稀疏编码，云端默认切换为 DashScope 原生 `qwen3.7-text-embedding` `dense&sparse` + Qdrant `sparse_v1 (modifier: "none")` RRF（私有化推荐 Ollama `bge-m3` 自动纯 Dense），后续在百万级客户语料上继续验证 Qdrant 神经稀疏索引与 PostgreSQL `pg_trgm` 授权目录检索的延迟与容量边界。
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
