# d9b1377 香港部署与真实复验

> 日期：2026-11-05。**候选部署成功；入库、权限与浏览器通过；问答质量总门禁 FAIL。**
> 当前版本不提升为稳定版，不把历史 RC、单轮延迟或 CI 通过解释为 Production GO。

## 版本与供应链

- 香港参考实例：2 vCPU / 4 GB、原生 `linux/amd64`、Compose；入口为 `https://unorag.unobyte.dev`。
- 部署提交：`d9b1377b666068dead5931ff7de925cf2431a723`；显示版本 `0.2.3-dev+d9b1377b6660`。
- Web、control、worker 的 DBOS application version 一致：`unorag-d9b1377b666068de`。
- [功能 PR #187](https://github.com/codexlin/UnoRAG/pull/187)、
  [安全补丁 PR #188](https://github.com/codexlin/UnoRAG/pull/188)、
  [精确主干 CI](https://github.com/codexlin/UnoRAG/actions/runs/42018142487)、
  [四镜像发布](https://github.com/codexlin/UnoRAG/actions/runs/42018229723) 均已完成。

| 镜像 | GHCR index digest |
|---|---|
| Web | `sha256:a22d9cc6cbe607c890bdee4edd5ed1332896c1c3b78abc3b93b651df83df5255` |
| Migrator | `sha256:ce839c5624b960dec6c3155ac32b2b836289308e1ab8adbd673f425ae0a93689` |
| Ops | `sha256:b79af9bf10b6a0dc51137b57538b7bb66a21802c4c8a6b4abf9d046b93562153` |
| Worker | `sha256:face6d704e619605a45a492b34538312bbb603feb69f47c94e4d8790ee15ed99` |

Manifest SHA-256：`b95eceae557fa7f725e9f26ae77502152ac13d4ddf00d1ce96ab9cba28b50fcd`。
四镜像 Trivy 门禁、Cosign 签名与发布端自验均通过；目标机再次验签后从 GHCR 拉取，没有 SSH 传输镜像、
目标机源码构建、关闭扫描或放宽签名策略。

首次 `9e77e78` 的[发布构建](https://github.com/codexlin/UnoRAG/actions/runs/42015753741)
被 Trivy 正确阻断：Debian `apt` / `libapt-pkg6.0` 2.6.1 命中
[CVE-2026-109518](https://security-tracker.debian.org/tracker/CVE-2026-109518)。该镜像没有部署。
PR #188 在三个运行时基础阶段先升级 APT，再安装其他依赖，并在旧 APT 升级过程中禁用下载重试。
同批修复可选离线评测器的 OpenAI / LangChain OpenAI 版本约束冲突；没有改变产品检索、模型或 Prompt。

## 升级与真实产品链路

升级前维护窗口备份 PostgreSQL、DBOS system database 与 Qdrant，五项校验和及 Qdrant 归档可读性均通过。
最终备份为 `pre-d9b1377-20261105T113036Z`，目录 `0700`、产物 `0600`。
COS 使用边界说明文件而非对象复制；这不证明桶级备份、复制策略或恢复能力。

升级脚本先排空旧业务任务和 durable workflows，保留上一版镜像 pins，迁移检查后启动同版本 Web/control/worker。
健康接口的 revision、digest、DBOS version 与 manifest 一致；最终 readiness 为 true、无降级。

| 检查 | 结果 | 范围 |
|---|---|---|
| 真实部署 smoke | PASS | MD 上传、Ask、Public Retrieve/Ask、Service Key scope/allow-list/撤销、库间隔离、替换、删除 |
| 完整隔离 | 29/29 PASS | 2 个组织、3 个工作区、principal ACL、Session/Service Key、文档/任务/下载/归档/trace IDOR、替换与删除后不可召回；fixture 清理通过 |
| 浏览器自动化 | 28/28 PASS，0 skip | 桌面/移动 Chromium，登录与水合、SSE 竞态、取消、会话切换、请求筛选与详情；高频 SSE 和部分诊断为受控响应，不算真实模型质量 |
| 公网边界 | PASS | 匿名请求记录 401；CSP、HSTS、X-Frame-Options、nosniff、Referrer-Policy 存在 |
| 生命周期巡检 | PASS | dead / stuck / deleting / cleanup errors / pending ACL 均为 0 |

## 新鲜入库与三轮黄金集

运行 `ab-stability-20261105T114813Z`，从精确 `d9b1377` 干净检出执行；三轮 `git_dirty=false`，
镜像、模型、Prompt 指纹一致。第一轮新建库并上传七份文件，后两轮只复用该不可变语料，不冒充重复入库。
结束后 runner 经产品删除并等待临时库清理完成。

实际存储为 COS；Chat/Judge 为 DashScope `qwen-plus`，Embedding 为 `text-embedding-v3`（1024 维）。
Ask `auto` 会按问题启用增强，不能仅凭部署默认值宣称 rerank 没运行。每轮 27/41 请求使用 hybrid；
实际请求详情确认比较题使用 rerank，图表题前两轮明确记录 `rerank_failed=true`。
没有 Fake 索引或模拟模型响应。

| 文件 | 实际解析 | 入库结果 |
|---|---|---|
| `contract-long.docx` | Mammoth | completed；Title 样式警告与 partial 保留 |
| `quote-big-80rows.docx` | Mammoth | completed；Title 样式警告与 partial 保留 |
| `report-narrative-5k.md` | 原生文本 | completed |
| `crosstable-large.pdf` | 302.AI MinerU | completed，无失败页 |
| `mixed-charts.pdf` | 302.AI MinerU | completed，无失败页 |
| `scan-lowcontrast.pdf` | 302.AI MinerU | completed，无失败页 |
| `twocolumn.pdf` | 302.AI MinerU | completed，无失败页 |

| 轮次 | 正例 | 拒答 | P50 | P95 | 最大耗时 |
|---|---:|---:|---:|---:|---:|
| 1 | 34/36 | 5/5 | 5.47 s | 9.11 s | 16.48 s |
| 2 | 34/36 | 5/5 | 5.80 s | 8.18 s | 16.30 s |
| 3 | 35/36 | 5/5 | 5.71 s | 8.19 s | 8.33 s |

合计 **118/123**。入库可靠性 PASS、原有 15,000 ms P95 门槛三轮均满足、model_error=0；
但完整 Ask stability / release gate 均为 **FAIL**，三轮通过数 0/3。没有增大门槛、修改金标、
关闭 Judge、重新评分或循环重跑挑选绿结果。

版本化评分的 document Recall/MRR、citation precision 均为 1，非法跨文档引用率为 0；
这些是有限黄金集指标，**不证明选中证据足以支持全局比较，也不是 Ragas 语义正确率**。

### 未通过项

1. **正文最高值比较答错，0/3**：case `d0b4cb5c00c38eb9`，路由为 compare、hybrid/rerank 成功，
   六条证据进入 Judge，最后只保留一条并生成了非最高候选，三项预期事实均缺失。
   尚未确认正确候选是在检索/rerank 阶段被裁掉，还是 Judge 选择错误；document Recall=1 无法区分。
   首轮 Request ID `fbf3a36b-1e97-4ea0-a693-3f9f0d2c59fb`，跟踪
   [#189](https://github.com/codexlin/UnoRAG/issues/189)。
2. **图表来源类型不稳定，1/3**：case `d2265bc68c95496e`，前两轮数值正确、引用 ID 合法，
   但引用是 text chunk 而非原金标要求的 image；同时 rerank 降级，检索阶段为 11.17 / 10.99 秒。
   第三轮无降级且通过。不能据此声称 MinerU 故障、网络故障或已确定 rerank 异常类型，跟踪
   [#190](https://github.com/codexlin/UnoRAG/issues/190)。

[#185](https://github.com/codexlin/UnoRAG/issues/185) 已补充当前延迟证据，但保持开放：当前候选仍不满足
质量与稳定性同时通过的要求。旧 `c066377` 的 P95 FAIL 与本轮结果分别保留，不改写历史。

总报告 SHA-256：`4a8b78ddee0d95dd0e5c181b1e00b156b8e0f0ffeed8269a4e1f8f0e0a9799fe`。
三轮原始报告：`ab_live_20261105T113457Z-218edfb3`、`ab_live_20261105T114052Z-48d8f801`、
`ab_live_20261105T114434Z-b51a41b5`。

## 可见浏览器真实操作

另建“香港新版验收 d9b1377”知识库，真实上传 MD 与独立 DOCX，两份均 ready；该小库保留供人工检查。
没有网络拦截或模拟响应：

- 员工手册问题答出“三个工作日”，点击来源核对原文；端到端 4.66 s，服务端 3.71 s，
  检索 314 ms、Judge 2.02 s、生成 1.26 s、持久化 2 ms。
  Request ID `655c345d-0189-420b-821b-057296891bd9`。
- 无资料问题拒答，零引用，不调用生成模型。
- 同型号查找返回两行规格与各自价格，不求平均；链路为 `deterministic_table_execution`，
  端到端 2.13 s。Request ID `f6ffc3e3-9a30-4380-a62a-f20e8c367ae3`。
- 入库详情展示 active v1、八阶段与排队耗时；手册执行 1.27 s、排队 2.22 s。
- 运行中心真实请求列表、Request ID 筛选、拒答筛选和详情可打开；慢请求瀑布与黄金集阶段数据一致。
- 1671×950 桌面、390×844 移动端检查并查看实际截图，文档详情、请求链路和长表格答案均无横向溢出。

浏览器脚本有两次断言编排错误：将空输入后的“发送”按钮误认为应启用；把“命中 2 行”的空格写漏。
读取原页面结果、按正确状态与空白规则检查后通过，没有重复提交问题、修改 UI 或将其归咎于产品。

## 边界与下一步

- 当前实例健康、主干 CI 与供应链通过，不等于回答质量全绿；先定位 #189、#190，再建立新不可变候选复验。
- 本轮未重做空安装、容量、停库故障、应用回滚或破坏性恢复；旧版本这些 PASS 不自动继承。
- 未启用完整 Ops Stack / 自托管 Langfuse，也未在香港重新采集正文或运行 Ragas 语义评分。
- 可选 Python 离线工具仍有无修复版本的 Ragas 多模态 SSRF 与 diskcache Pickle advisory；
  不属于产品镜像，当前工具只允许文本指标且未启用共享持久缓存，但不能宣称零 advisory。
  仅在可信、私有离线环境运行，不接收任意第三方评测插件或共享可写缓存。
- 公开只提交脱敏汇总；原始阶段记录、截图、质量报告与隔离报告留在受控目录，不提交凭据、完整问答或来源正文。
