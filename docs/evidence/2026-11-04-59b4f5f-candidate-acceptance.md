# 59b4f5f 候选发布验收

> 日期：2026-11-04。结论：**RC 门禁 GO，可进入受控试点；未发布稳定版，未升级正式实例**。
> 只证明下列提交、镜像、配置和隔离环境，不是客户容量、SLA 或通用 production-ready 认证。

## 候选与环境

- 提交：`59b4f5fab3824d0cb8112e24c1afd4c4f617dc73`，产品版本 `0.2.3-dev+59b4f5fab382`。
- DBOS application version：`unorag-59b4f5fab3824d0c`；四镜像均为原生 `linux/amd64`，未使用平台模拟。
- [修复 PR #176](https://github.com/codexlin/UnoRAG/pull/176)、
  [精确主干提交 CI](https://github.com/codexlin/UnoRAG/actions/runs/41848938006)、
  [四镜像构建、扫描与签名](https://github.com/codexlin/UnoRAG/actions/runs/41848995294) 均通过。
- 香港 2 vCPU / 4 GB RAM 主机上的独立 Compose 项目，与稳定实例共用硬件，但数据库、Redis、Qdrant、
  凭据和文档作用域独立，只绑定 loopback。入库队列并发为 1，LLM 并发上限为 2。
- 真实链路为腾讯 COS、DashScope `qwen-plus` / `text-embedding-v3` 与 302.AI MinerU。
  模型名称不是不可变权重标识；结果只对应本次运行时点。没有使用 Fake index 或模拟回答替代黄金集。

| 镜像 | GHCR index digest |
|---|---|
| Web | `sha256:9097a787104a2d5d636928651932b280e055898929a71a906d40e93daf6e1b96` |
| Migrator | `sha256:7fc7f2dd6b50ebb4e1cea76b642b7cf444f3b290b776d505cb3391e025aa691f` |
| Ops | `sha256:381431c4f028da44b780aa09d2ef5147877ef3c3b2d0e4375a7da751edf93bfe` |
| Worker | `sha256:86e6d81ec4c68a99858e554ecfdaa6eca8c44467e54453e0a8b1a2bb6760b24e` |

Manifest SHA-256 为 `eb4f760cae7fbbf038e06f44a9aae9b0767490a6f930979f3ad0e35e34c11a7f`。
四镜像按既有 Trivy HIGH/CRITICAL、`ignore-unfixed` 策略通过，未增加豁免；Cosign 签名与安装时验签通过。
另外检查了各 index 的 amd64 runtime 及关联 attestation，四者都有 SPDX SBOM 与 SLSA provenance v1。

## 门禁结果

| 门禁 | 结果 | 范围 |
|---|---|---|
| 确定性检查 | PASS | Node 22：Fast 655、Contract 32、真实 PG/Qdrant/Redis Integration 77，均无跳过；verify、生产构建和生产依赖审计通过 |
| 空环境安装 | PASS | 先验证旧稳定版空安装；升级演练后真实删卷，再用候选 manifest 直接安装空库，首次强制改密与 smoke 通过 |
| 升级 / 回滚 / 再升级 | PASS | digest 切换前排空任务与 workflow；同一文档的 active version、引用和真实 Ask 保持一致 |
| 产品 smoke | PASS | 上传、Ask、Service Key scope/撤销、Public API、隔离、替换、删除 |
| 浏览器 | 20/20 PASS | 桌面与移动 Chromium；真实登录、页面、初次 Ask hydration；高频 SSE、竞态与部分归档响应是受控 fixture |
| 新鲜入库 | 7/7 completed | 一次真实入库，后续三轮复用同一不可变知识库；4 份 PDF 经真实 MinerU |
| 三轮质量与稳定性 | 3/3 PASS | 每轮正例 36/36、拒答 5/5，共 123/123；构建指纹一致，model_error 为 0 |
| S1/S2 隔离 | 29/29 PASS | 跨组织、跨 Workspace、Service Key、ACL、元数据、IDOR、替换和删除；上轮中止后的检查也全部执行 |
| Provider 故障 | PASS | LLM 401/429/503、Embedding 超时/401、MinerU 401；失败替换保留旧 active，恢复后真实 Ask 正常 |
| Judge 运行记录 | PASS | 三次 HTTP 故障在运行中心显示 failed / judge_unavailable；PG 阶段账本保存正确的类别、次数与预算 |
| 故障后 MinerU | PASS | 移除故障代理后另上传跨页表 PDF，真实 302.AI MinerU 完成，无失败页 |
| 真实会话与 SSE | PASS | 临时问答、归档、真实模型追问、SSE token/done 一致；删除来源后拒答且无旧内容或引用 |
| 破坏性恢复 | PASS | 真实备份、校验、删卷、恢复；恢复耗时 36 秒，恢复探针丢失为 0 |
| 恢复后源文件 | PASS | 已保留的 COS 原文件可经鉴权下载，89 字节，SHA-256 与恢复前完全相同 |

浏览器受控 fixture 结果不冒充模型真链路，另有真实 API/SSE 会话测试补充。原生诊断通过产品 API 与
PG 账本验证；本轮没有启用完整 Ops Stack、OTel 外部导出或自托管 Langfuse，不能扩大为这些平台的验收。

## 三轮质量

| 轮次 | 正例 | 拒答 | Citation precision | P50 | P95 | 最大耗时 |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 36/36 | 5/5 | 100% | 7.51 s | 12.30 s | 12.72 s |
| 2 | 36/36 | 5/5 | 100% | 7.38 s | 12.40 s | 13.70 s |
| 3 | 36/36 | 5/5 | 100% | 7.28 s | 13.68 s | 18.55 s |

门槛保持每题通过、事实覆盖/召回/precision/拒答为 100%，各轮 P95 不超过 15 秒，model_error 为零；
没有调高阈值、关闭 Judge、修改问题或挑选重跑结果。跨页表 6 题、低对比扫描 5 题均三轮全部通过。
三轮的最大耗时不等于 P95，不能据此声称每次请求都低于 15 秒。

`contract-long.docx`、`quote-big-80rows.docx` 经 Mammoth；`report-narrative-5k.md` 经原生文本解析。
`crosstable-large.pdf`、`mixed-charts.pdf`、`scan-lowcontrast.pdf`、`twocolumn.pdf` 经真实 302.AI MinerU，
均无失败页。两份 DOCX 保留 `Title` 样式 warning 与 partial 标记，未隐藏为完全无警告成功。
`mixed-charts.pdf` 只证明叙事文字，不证明 ChartIR 或图表数值理解。

## 三项阻断复验

- [#174](https://github.com/codexlin/UnoRAG/issues/174)：完整隔离套件复验跨 Workspace/组织公共 Ask 拒绝，
  不再误映射为可重试 502；无越权内容，缺失资源与无权资源的行为不泄露外部元数据。
- [#173](https://github.com/codexlin/UnoRAG/issues/173)：新 JSON/SSE 文案、阶段、Trace 与指标有回归。
  部署中的故障注入证明 PG/运行中心记录为失败；401 为 authentication、1 次且不可重试，429/503 为
  rate_limit/provider_unavailable、各 2 次应用层尝试。对应 SDK HTTP 调用分别为 1/6/6 次，不能混为同一计数。
  故障 overlay 每次 Judge 执行上限为 12 秒；正常质量测试仍使用原配置，未通过提高预算消除失败。
- [#172](https://github.com/codexlin/UnoRAG/issues/172)：主来源、类型和完整事实要求保留；辅助来源显式绑定
  事实。合法/无关/冲突/小数金额等价均有回归，三轮新鲜入库质量门禁通过。本轮实际没有辅助来源 Citation，
  合法辅助分支由确定性回归验证；词法匹配不等于普适语义蕴含或冲突检测。

前一候选 `a71e14f` 的 NO-GO 保持不变，见
[不可变历史报告](https://github.com/codexlin/UnoRAG/blob/d5fc83d5cb7023fa2cee6e38935182b59df4386b/docs/evidence/2026-11-04-a71e14f-candidate-acceptance.md)。
本报告是修复后的新候选实测，不是重评分或改写旧失败。

## 恢复与收尾边界

PostgreSQL、DBOS system database 与 Qdrant 在删卷后恢复，备份五项校验和均通过。36 秒是本次小型
恢复探针的观察值，不是客户完整数据量的 RTO；探针数据丢失为 0 不等于所有场景零丢失承诺。
COS 对象保留在原桶中，只验证恢复后源文件仍可读且一致，未验证桶级恢复、对象误删或跨区域复制。
Provider 故障由受控 HTTP 代理注入，不等于真实重启外部托管模型或 MinerU；本轮也未单独演练执行中的
Worker 非优雅崩溃。正式实例未进行破坏性恢复或公网 TLS 切流。

最终巡检 `dead=0 / stuck=0 / pending ACL=0 / cleanup errors=0`，Qdrant 测试集合 point 数为 0。
临时容器、卷、SSH 转发与复制的凭据均已清理，备份和原始脱敏报告保留在受控工作目录。正式实例
仍为 `v0.2.3` / `1e95f26c7026e43990aeeca703fa5562e936640a`，公网 readiness 健康。

非阻断收尾事项：

1. [#177 验收拓扑清理](https://github.com/codexlin/UnoRAG/issues/177)：脚本直接级联删除 PG 拓扑后留下
   3 个测试 COS 对象与 6 个向量点。本轮确认测试组织已不存在后，按精确文档/版本标识清理，未扩大
   COS 权限或修补产品业务库。后续脚本应先调用产品删除并等待终态，再清拓扑，不能忽略清理失败。
2. DOCX `parser_report` 的 Mammoth 标签仍硬编码为 `1.10.0`，实际锁文件为 `1.12.3`，不以该标签证明组件版本。
3. Judge 失败 detail 已入库，但运行中心事件详情尚未投影细分类别、次数和预算；目前需读取 PG 账本或内部
   `retrieval_debug`。不把本轮“失败可见”扩大为诊断展示已经完整。

原始证据包括三份 `ab_live_20261104T145548Z-fc3dd430`、`ab_live_20261104T150212Z-6be3611c`、
`ab_live_20261104T150655Z-55121277` 报告，`ab_stability_20261104T151156Z` 总报告，及
`upgrade-rollback.json`、`provider-faults.json`、`judge-ledger.json`、`mineru-recovery.json`、
`conversation-live.json`、`restore-drill.json`、`cos-boundary.json`、`isolation.json`、`attestations.json`。
公开仓库只保存汇总；密码、备份、完整问题/回答、引用正文与环境文件不入 Git。
