# UnoRAG v0.1.0-rc.18 LLM 背压与容量验收

- 日期：2026-08-22（Asia/Shanghai）
- 提交：`61e564254abbf5ed34e33b772b8956783823c5ea`
- 发布：[`v0.1.0-rc.18`](https://github.com/codexlin/UnoRAG/releases/tag/v0.1.0-rc.18)
- 发布流水线：[`32537559268`](https://github.com/codexlin/UnoRAG/actions/runs/32537559268)
- 环境：UnoRAG-HK，公网 `https://unorag.unobyte.dev`
- 结论：**共享 LLM 并发门、超时语义、真实容量阶梯和复杂 PDF 入库全部 PASS**

## 发布与升级边界

四个运行时镜像通过构建、Trivy 扫描、Cosign 签名与离线透明日志校验，以 digest 固定到 RC.18
发布清单。香港环境从 RC.17 原位升级，旧 DBOS application version 排空后再切换；迁移、运行时
数据库角色校验、ACL reconcile 和 lifecycle inspect 均通过。升级后的 pilot smoke 覆盖：

`upload -> ask -> Public Retrieve/Ask -> service-key scope/revoke -> library isolation -> replace -> delete`

Qdrant 在应用升级前按官方 self-hosted 要求逐 minor 迁移：
`1.13.2 -> 1.13.6 -> 1.14.1 -> 1.15.5 -> 1.16.3 -> 1.17.1 -> 1.18.3 -> 1.19.0`。
每一步均等待健康并验证 `unorag_chunks` 可读。迁移前冷备份及 SHA-256 校验保存在主机
`/home/ubuntu/unorag-backups/pre-rc17-20260821T231816Z`；COS 对象存储作为独立备份边界记录，未复制到
该目录。升级策略依据 [Qdrant Upgrade](https://qdrant.tech/documentation/operations/upgrades/) 与
[Snapshots](https://qdrant.tech/documentation/snapshots/) 文档。

## 根因与修复

RC.14 虽然 Ask 并发 20 全部成功，但 `LLM_MAX_INFLIGHT=2` 没有被 TypeScript Ask 运行时消费，
因此不能证明应用具备背压。RC.17 接入共享并发门后，真实复跑出现 7 个约 30.9 秒的错误拒答：
20 个请求均返回 HTTP 200，但只有 13/20 质量通过。

根因是 provider 的 15 秒执行计时器在取得并发 permit **之前**启动。后排请求的队列等待消耗了
provider 预算，Judge 两次超时后按 `judge_unavailable` 失败关闭。RC.18 将 admission 移到 provider
计时器之外，使两类预算独立：

- `LLM_MAX_QUEUE` / `LLM_QUEUE_TIMEOUT_MS`：限制进入模型前的等待和队列长度；
- provider timeout：只计算取得 permit 后的真实模型执行时间；
- permit 在成功、异常、超时、取消和客户端断开时均释放；
- Prometheus 只记录在途、队列、等待和结果，不记录 prompt 或文档内容。

聚焦回归覆盖了“排队不消耗 provider 预算”和异常释放 permit。RC.18 的 lint、类型检查、TS core
（346 pass、22 integration skip）和应用测试（206 pass、1 integration skip）均通过，GitHub 的四镜像
构建与扫描也全部通过。

## 容量校准

首次 RC.18 复跑沿用 `LLM_MAX_INFLIGHT=2`、`LLM_MAX_QUEUE=32`、
`LLM_QUEUE_TIMEOUT_MS=30000`：Ask c1/c5/c10 全通过；c20 中 18/20 正确，2 个请求在约 31 秒以稳定
`503 service_unavailable` 返回。指标为 `timed_out=2`、`overloaded=0`，成功回答质量 18/18，证明错误
拒答已修复，剩余边界是部署队列等待预算，而非 provider 或引用质量故障。

依据该主机和 provider 的实测服务时间，将 UnoRAG-HK 的队列等待预算校准为 45 秒后完整重跑。它低于
客户端 65 秒请求上限，仍由 32 个队列上限提供硬背压。仓库默认值保持 30 秒，其他部署必须按自己的
副本数、模型延迟和可接受尾延迟定容，不能照搬 45 秒。

## 最终容量结果

测试从公网 HTTPS 创建隔离知识库和临时 service key，语料包含唯一 marker；成功不仅要求 HTTP 200，
还要求 citation 命中 marker。测试结束后撤销 key 并删除知识库。

### Retrieve

| 并发 | 请求 | 成功 / 质量通过 | P50 | P95 | P99 |
|---:|---:|---:|---:|---:|---:|
| 1 | 5 | 5 / 5 | 0.603s | 0.832s | 0.832s |
| 5 | 10 | 10 / 10 | 0.365s | 0.574s | 0.574s |
| 10 | 20 | 20 / 20 | 0.303s | 0.466s | 0.550s |
| 20 | 40 | 40 / 40 | 0.466s | 0.709s | 0.903s |

共 75/75 成功、75/75 质量通过，无拒答或 HTTP failure。

### Ask

| 并发 | 请求 | 成功 / 质量通过 | P50 | P95 | P99 |
|---:|---:|---:|---:|---:|---:|
| 1 | 2 | 2 / 2 | 5.641s | 6.133s | 6.133s |
| 5 | 5 | 5 / 5 | 14.061s | 15.697s | 15.697s |
| 10 | 10 | 10 / 10 | 22.160s | 25.831s | 25.831s |
| 20 | 20 | 20 / 20 | 42.900s | 49.827s | 50.925s |

共 37/37 成功、37/37 质量通过、0 拒答。c20 尾延迟明显增加，这是两个模型槽位提供真实背压的
直接代价，不应和 RC.14 未受控的 provider 并发数据作等价性能比较。

最终指标快照：`concurrency_limit=2`、`acquired=76`、`timed_out=0`、`overloaded=0`、
`cancelled=0`、累计 queue wait `946.468s`；测试结束后 `inflight=0`、`queue_depth=0`，未发现 permit
泄漏。

### 入库与 MinerU

| 并发任务 | 完成 | 失败 | Ready P50 | Ready P95 |
|---:|---:|---:|---:|---:|
| 1 | 1 | 0 | 3.299s | 3.299s |
| 2 | 2 | 0 | 5.878s | 6.286s |
| 4 | 4 | 0 | 4.288s | 4.661s |

`testdata/ab/mixed-charts.pdf`（330,326 bytes）经公网 API、COS 和 DBOS Worker 进入 302.AI MinerU：

- 状态：`completed / done`，总 Ready 16.953 秒；
- parser/backend：`mineru`，provider：`302ai`；
- mode：`structured`，`partial=false`，warnings 0。

最终 lifecycle 巡检中 dead、stuck、deleting、cleanup error、pending ACL projection 和过期 tombstone
均为 0；健康端点为 `live_ready=true`、`ask_ready=true`、`degraded=false`。

## 适用范围

本报告证明 RC.18 在单 Web、单 Worker、2 个共享 LLM 槽位和当前外部 provider 下，受控的短时并发
阶梯没有 citation 质量回归。它不是最大容量、持续 soak、provider 限流或多副本全局并发证明。
当前并发门是每个 Web 副本本地边界；增加 Web 副本时，总 LLM 并发约为“副本数 × 每副本上限”，必须
重新做容量规划。原始 JSON 保存在 gitignored 的 `scripts/acceptance/.capacity_rc18_*.json`，不包含
管理员密码或 service key。
