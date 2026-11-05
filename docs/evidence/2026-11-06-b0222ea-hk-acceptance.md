# b0222ea 香港候选复验

> 日期：2026-11-06（Asia/Shanghai；机器报告使用 UTC）。**候选升级成功，本轮知识质量、隔离、浏览器与 Qdrant 故障恢复检查通过。**
> 未发布新稳定版，未重做全部交付门禁，不宣称通用 Production GO。历史 FAIL 不改写。

## 版本与供应链

- 实例：`https://unorag.unobyte.dev`，香港 2 vCPU / 4 GB，原生 `linux/amd64`、Compose、COS。
- [PR #192](https://github.com/codexlin/UnoRAG/pull/192) 已合并，运行提交为
  `b0222ea2716ee567264fef524403339f559105ec`，版本为 `0.2.3-dev+b0222ea2716e`。
- Web/control/worker 的 DBOS application version 均为 `unorag-b0222ea2716ee567`。
- [精确主干 CI](https://github.com/codexlin/UnoRAG/actions/runs/42062878988) 六项通过，包含 Node.js 22
  的 verify、快速测试 812/812、真实 PG/Qdrant/Redis 集成 82/82（0 skip）、依赖审计和构建。
  本地契约测试 32/32（0 skip）、migration 检查通过。
- [候选镜像发布](https://github.com/codexlin/UnoRAG/actions/runs/42063721459) 的四镜像 Trivy
  HIGH/CRITICAL 门禁、SBOM/provenance、Cosign 签名与发布端自验通过。目标机再次验签后从 GHCR 拉取；
  未使用浮动 latest、SSH 传输镜像、目标机源码构建或关闭签名验证。

| 镜像 | GHCR index digest |
|---|---|
| Web | `sha256:4b6b33293f8fb49a7e5ba1199d8ffc68c73d734ffff2fff1bfb019df11feb3a5` |
| Migrator | `sha256:18a3c6a60349c6c51769d4ac913742f0886adf205681e266ceeffaeef606946d` |
| Ops | `sha256:3ae2eaef7ded6b965b30a963c71c8e3419f92552ad9338d8cf545ad87d845f9f` |
| Worker | `sha256:d1fb7cce568b5e0c2dd0fe53281fb8b66cdb86b70814ccd242c482994c41685d` |

Manifest SHA-256：`5d5a5ed88f0aff011b3e516c4ffd4cd121aa9f19f02b66510569a3467af9e60d`。
升级后及故障演练后均核对了 readiness、三个运行容器的 revision、实际 image 与 DBOS version，全部一致。

## 升级、备份与产品链路

升级前完成维护窗口备份：`pre-b0222ea-20261106T0028`。PostgreSQL、DBOS dump、Qdrant、manifest、
COS 边界说明的五项校验和通过；Qdrant tar 和 DBOS `pg_restore -l` 可读，目录 0700、产物 0600。
COS sidecar 不是桶级对象副本，不能作为 COS 恢复成功的证据。旧镜像 pins、备份与上一版镜像保留。

| 检查 | 结果与边界 |
|---|---|
| 升级内置 smoke | PASS：MD 上传、Ask、Public Retrieve/Ask、Service Key scope/allow-list/撤销、库间隔离、替换、删除 |
| 完整隔离 | 29/29 PASS：2 组织、3 工作区、principal ACL、Session/Service Key、文档/版本/任务/下载/归档/trace IDOR，以及替换和删除后的不可召回；fixture 清理通过 |
| 桌面/移动自动化 | 28/28 PASS，0 skip：登录、水合、SSE 取消/竞态/切库、请求筛选和详情；高频 SSE 与部分诊断采用受控响应，不算真实模型质量 |
| 公网边界 | 匿名请求记录 401；CSP、HSTS、X-Frame-Options、nosniff、Referrer-Policy 存在 |
| 生命周期巡检 | dead/stuck/deleting/cleanup errors/pending ACL 及过期 tombstone 均为 0 |
| HK 宿主机 offline preflight | 退出 2：没有 pnpm，不记录为 PASS；这是 Docker-only 宿主机，精确代码门禁在 Node.js 22 CI 执行，未为此安装开发工具链 |

## 真实入库与三轮质量

第一轮新建库、上传七份版本化真实文件；第二、三轮复用同一不可变语料。三轮的提交、镜像、模型和 Prompt
指纹一致，`git_dirty=false`。临时评测库最终经产品接口删除并等待清理完成，没有 Fake 索引或模型响应。

| 文件 | 实际解析 | 解析耗时 | 结果 |
|---|---|---:|---|
| `contract-long.docx` | Mammoth | 516 ms | completed；原 Title 样式警告/partial 保留 |
| `quote-big-80rows.docx` | Mammoth | 450 ms | completed；原 Title 样式警告/partial 保留 |
| `report-narrative-5k.md` | 原生文本 | 245 ms | completed |
| `crosstable-large.pdf` | 302.AI MinerU | 523.83 s | completed，无失败页 |
| `mixed-charts.pdf` | 302.AI MinerU | 188.20 s | completed，无失败页 |
| `scan-lowcontrast.pdf` | 302.AI MinerU | 15.67 s | completed，无失败页 |
| `twocolumn.pdf` | 302.AI MinerU | 26.35 s | completed，无失败页 |

复杂 PDF 队列串行，最后一份排队约 731 秒；七份最终在原有 900 秒总等待预算内完成。
长表期间 Worker/Qdrant 约 165/156 MiB、CPU 约 3.1%/0.03%，MinerU 提交与轮询请求持续成功。
这支持“本次时间主要消耗于解析与串行排队”，**不能证明上游内部排队、网络或具体模型环节的根因**。
当前日志未持续暴露上游任务状态，该层诊断仍有改进空间；没有因此提高并发或放宽超时。

真实模型：Chat/Judge `qwen-plus`、Embedding `text-embedding-v3`（1024 维）、Rerank `qwen3-rerank`。
Chat/Judge Prompt 分别为 1.4.0/1.3.0。金标、Judge 和 15,000 ms P95 门槛没有调整。

| 轮次 | 正例 | 拒答 | P50 | P95 | 最大耗时 |
|---|---:|---:|---:|---:|---:|
| 1 | 36/36 | 5/5 | 5.37 s | 9.58 s | 11.37 s |
| 2 | 36/36 | 5/5 | 5.58 s | 8.98 s | 11.34 s |
| 3 | 36/36 | 5/5 | 5.51 s | 9.79 s | 11.37 s |

合计 **123/123**，ingest reliability、Ask stability、该评测器的 release gate 均 PASS，model_error=0。
各轮版本化 document Recall/MRR、citation precision 为 1，非法引用率为 0；这些有限集指标不是 Ragas
语义正确率或全语料保证。首轮部分时间与受控浏览器 E2E、两份原生格式 UI 入库重叠，不是独占容量压测；
未并行发起额外真实 Ask，也未通过失败后循环重跑挑选结果。

### 两个目标缺陷

| 项目 | 旧 d9b1377 | 本候选 | 本轮行为 |
|---|---:|---:|---|
| #189 正文最高值比较 `d0b4cb5c00c38eb9` | 0/3 | 3/3 | 比较上下文补入 4 条同作用域候选，最终 6 条证据；原 TopK/权限边界未放宽 |
| #190 图表来源 `d2265bc68c95496e` | 1/3 | 3/3 | 引用同时保留 chunk 与真实 figure，三轮 rerank_failed=false；不宣称具备 ChartIR 数值理解 |

首轮 Request ID 分别为 `cf7a613f-933c-4d9a-93f3-ba18ace20c79`、`2ada866f-d0e1-4841-b399-3b1c19b890e6`。
旧 118/123 FAIL 见 [d9b1377 报告](./2026-11-05-d9b1377-hk-acceptance.md)；机制与效果/成本解释见
[修复案例](./2026-11-05-comparison-lineage-fix.md)。本轮变化不是仅增加诊断，比较题的上下文与 Prompt 已改变。

原始轮报告：`ab_live_20261105T163619Z-5022b1f2`、`ab_live_20261105T165244Z-c0909f8f`、
`ab_live_20261105T165616Z-702c1ce4`；汇总 `ab_stability_20261105T165953Z`。
汇总 JSON SHA-256：`a7c894dc060225c7ea82cdaf5aa8bc7b2c25f81400c0fd26397c4e78d6aeee86`。

## 可见浏览器与真实故障

手动通过浏览器创建“香港新版验收 b0222ea”，上传 MD、DOCX 并确认两份 ready；该小库保留供人工检查。
手册回答命中既定事实并附 1 条来源，端到端 4.77 s、服务端 4.28 s；表格查找返回目标行而非平均值，
端到端 2.38 s、服务端 1.87 s，阶段包含 table_plan/table_execute；无资料问题为 refused、零引用、未调用生成。
三个 Request ID 为 `cebec28c-458c-4e2a-9d59-bdc0d81dd698`、`cb6e9f8b-ed66-4c78-943d-a9e97c9a1e2e`、
`cc163056-9b8e-4ee7-9a89-ed8ebd78f965`，PG 终态与页面一致。

在确认无在途生命周期任务后，仅停止 Qdrant。请求返回 503、没有答案，并携带
`X-Request-ID: 43122890-da16-45e2-a22c-9d38c1a7bce3`；PG、结构化日志与请求详情关联一致：

- `query / transport / ENOTFOUND`，上游 HTTP 状态为 null；这是停止容器后的 DNS 失败，不是 Qdrant 返回 HTTP 503。
- 调用 15 ms、检索节点 310 ms、整次请求 339 ms；route/plan/rewrite 为 completed，retrieve 为 failed。
- 尝试次数 1，未增加自动重试；尚未取得的 retrieval_mode 保持 null。
- `finally` 恢复 Qdrant 后，同一 Web 进程问答成功，Request ID `ddabce01-163b-44e9-a1e0-35208109ea66`。
  Web 自 `2026-11-05T16:32:10Z` 起运行，未通过重启应用掩盖恢复问题。

真实成功/失败请求详情、入库瀑布均检查 1671×950 桌面和 390×844 移动截图，未发现横向溢出。
故障历史保留，不因恢复而删除。

验收工具的边界也保留：首次故障脚本误要求阶段 ended_at 非空；现行 Ask 契约仅有阶段 duration 和 run
起止时间。按契约复核了**同一次失败请求**，没有第二次停机或改产品代码。另一次只读观测遇到本机代理
198.18 地址连接超时，重新读取成功，不计为产品故障。浏览器扩展也曾拦截菜单指针事件，不归因于产品。

## 保留边界与下一步

- 历史一次本地 Qdrant 503 的确切根因仍未知，[#193](https://github.com/codexlin/UnoRAG/issues/193)
  保持开放；本轮只证明新增诊断已部署、受控故障可关联和恢复，不证明旧问题由 DNS 导致或已根治。
- 入库轮询期间曾观察到新建库后没有自动选中新库，手动选择后上传正常；空闲场景复测自动选中正常。
  暂未形成稳定复现，不直接改状态逻辑；后续应针对轮询并发场景验证，而不是宣称已修复。
- 本轮未重做空环境安装、候选/旧版完整回滚前滚、破坏性 restore、容量压测或完整 Provider 故障矩阵。
  升级前备份校验通过不等于恢复演练通过，历史版本 PASS 不自动继承。
- 未部署完整 Ops Stack/自托管 Langfuse，也未重跑 Ragas 语义评分。可选离线 Python 工具的 Ragas SSRF 与
  diskcache Pickle advisory 仍按原边界处理，不属于产品镜像，不宣称零 advisory。
- 公开仅提交脱敏汇总，原始报告、截图、Provider 记录、测试凭据与故障日志保留在受控忽略目录。
