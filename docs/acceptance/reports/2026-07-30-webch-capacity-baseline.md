# webch 最低规格容量基线

> 日期：2026-07-30（UTC+8）
>
> 环境：`https://webch.cn`，阿里云 Docker Compose
>
> 测试器提交：`e610593`
>
> 数据库权限修复：`56d52ea`

## 结论

在 webch 的 **2 vCPU / 1.8 GiB RAM** 最低规格上，Public Retrieve、Public Ask、
普通文档并发入库和真实 MinerU 扫描 PDF 均完成端到端测试。最终轮共执行
75 次 Retrieve、37 次 Ask、8 个普通 Markdown ingest（含 seed）和 1 个
MinerU ingest，HTTP、引用质量和 Job 终态均为 **PASS**。

Retrieve 在 20 并发时仍为 `40/40` 成功，P95 为 `3.63s`；Ask 在 20 并发时
仍为 `20/20` 成功，但 P95 增长至 `21.13s`，吞吐从 10 并发起稳定在约
`0.93 req/s`。同时 API 峰值达到 `167% CPU`。因此该规格适合作为预发布或
低并发私有部署起点，不应承诺高并发 Ask SLA。

本报告是短阶梯基线，不是持续压测或任意客户环境的容量承诺。

## 环境

| 项 | 值 |
|---|---|
| 主机 | 2 vCPU、1.8 GiB RAM、1 GiB swap |
| 磁盘 | 40 GiB，测试后使用 87%，剩余约 5.1 GiB |
| 拓扑 | Caddy → Next.js Web → FastAPI；PostgreSQL、Qdrant、Redis、lifecycle/outbox worker 同机 |
| 容器限制 | 未配置 CPU / memory hard limit |
| 检索与模型 | 真实 Qdrant、真实 embedding、真实 LLM，不使用 stub |
| MinerU | 真实扫描 PDF，`backend=mineru`、`route=mineru` |
| 数据集 | 每轮创建隔离临时文库和唯一 proof marker，结束后等待文库进入 `deleted` |

## 测试方法

[`capacity_baseline.py`](../../../scripts/acceptance/capacity_baseline.py) 只经过产品边界：

1. 使用管理员会话创建临时文库；
2. 上传唯一 Markdown 并等待 seed Job 完成；
3. 创建仅允许该文库的 `ask/retrieve` Service Key；
4. 对 `/api/v1/retrieve` 和 `/api/v1/ask` 执行阶梯并发；
5. 并发上传 1、2、4 个真实 Markdown 并等待 Job 终态；
6. 上传 `testdata/pdf/leave-scanned.pdf` 验证真实 MinerU；
7. 吊销 Service Key，删除文库并等待删除完成；
8. 运行 lifecycle 巡检和 edge health。

每个 Retrieve/Ask 成功样本还必须满足：

- HTTP 2xx；
- 未拒答；
- citation 中包含该轮唯一 marker。

## Public Retrieve

| 并发 | 请求 | 成功/质量通过 | 吞吐 req/s | P50 | P95 | P99 |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 5 | 5 / 5 | 1.71 | 0.59s | 0.72s | 0.72s |
| 5 | 10 | 10 / 10 | 4.54 | 1.01s | 1.26s | 1.26s |
| 10 | 20 | 20 / 20 | 6.68 | 1.12s | 1.90s | 1.92s |
| 20 | 40 | 40 / 40 | 7.07 | 2.29s | 3.63s | 4.40s |

20 并发仍无错误或引用退化，但从 10 到 20 并发吞吐只增加约 6%，延迟明显上升。
在该主机上，交互式 Retrieve 建议以 5 并发为初始预算，10 并发作为扩容前观察线。

## Public Ask

| 并发 | 请求 | 成功/质量通过 | 吞吐 req/s | P50 | P95 | P99 |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 2 | 2 / 2 | 0.26 | 3.53s | 4.04s | 4.04s |
| 5 | 5 | 5 / 5 | 0.85 | 4.36s | 5.89s | 5.89s |
| 10 | 10 | 10 / 10 | 0.93 | 9.22s | 10.76s | 10.76s |
| 20 | 20 | 20 / 20 | 0.94 | 18.28s | 21.13s | 21.35s |

Ask 在 10 并发后吞吐基本不再增长，继续放大只形成排队。该规格的初始建议是：

- 单实例最多 5 个交互式 Ask in-flight；
- 超出预算时在 edge/Redis 做有界排队或返回稳定 429；
- 需要 P95 小于 6 秒时，不以 10/20 并发作为可承诺工作区间；
- 在更高并发承诺前，先拆分/扩容 API，并对目标模型 Provider 单独压测。

吞吐平台由 API CPU、embedding/rerank/LLM 外部调用共同影响；本轮数据不能把瓶颈
单独归因于某一个组件。

## 入库

### 普通 Markdown

| 并发 Job | 完成 | 接受 P95 | Ready P50 | Ready P95 / max |
|---:|---:|---:|---:|---:|
| 1 | 1/1 | 0.42s | 1.97s | 1.97s |
| 2 | 2/2 | 0.21s | 1.71s | 2.04s |
| 4 | 4/4 | 0.92s | 2.70s | 3.72s |

并发 4 没有失败，worker 能按容量排队。当前最低规格仍应保留 local worker
capacity 的保守默认值，不因短小 Markdown 结果直接提高复杂 PDF 并发。

### MinerU 扫描 PDF

| 文件 | 大小 | 结果 | Parser | 总 Ready | Parser latency | 降级 |
|---|---:|---|---|---:|---:|---|
| `leave-scanned.pdf` | 29,434 B | completed | MinerU | 11.63s | 1.09s | 否 |

这是单文件路径验证，不是 MinerU 并发容量。MinerU 仍应保持独立 queue class 和
并发 1 的保守起点，再按客户真实 PDF 页数、限额和 Provider 延迟复测。

## 资源峰值

每约 2 秒采集一次 `docker stats`；实际取得 22 组样本。

| 服务 | CPU 峰值 | 内存峰值 |
|---|---:|---:|
| API | 167.35% | 307.4 MiB |
| Web | 15.81% | 236.3 MiB |
| lifecycle worker | 27.89% | 197.0 MiB |
| PostgreSQL | 8.62% | 71.8 MiB |
| Qdrant | 3.90% | 60.1 MiB |
| Redis | 2.63% | 11.1 MiB |

API 已接近占满两核，是该规格继续提高 Ask 并发前最明确的本机资源信号。内存没有
出现 OOM，但主机本身已使用 swap，且同机还有非 UnoRAG 进程，不能将容器峰值简单
等同于整机余量。

## 测试发现并修复的问题

首轮完整测试中，Retrieve、Ask 和普通入库均通过，但复杂 PDF 在写 parser report
时进入 dead，文库最后一个删除 Job 也无法完成。根因是新最小权限数据库角色缺少：

1. `app.jobs.payload` 的列级 UPDATE；
2. `app.outbox_events.idempotency_key` 的列级 SELECT，后者是
   `ON CONFLICT (idempotency_key)` 所需权限。

`56d52ea` 增加最小列级授权和部署期权限断言。webch 幂等应用后，本轮测试产生的
失败 Job 通过受控运维操作重新排队或关闭，随后缩小复测和本报告完整复测均通过。
最终巡检：

```text
dead_jobs=0
stuck_jobs=0
deleting_documents=0
cleanup_errors=0
edge_health=PASS
```

## 发布判断与后续

**本轮结论：最低规格容量基线 PASS，受控低并发试点可继续。**

上线前仍应处理：

1. webch 磁盘 87% 已超过舒适水位，应扩容或清理后设置 80/85/90% 告警；
2. 为 Public Ask 增加集群级并发预算/有界排队，不能只依赖进程内每分钟限流；
3. 在真实客户硬件、模型 Provider 和代表性语料规模上重复同一脚本；
4. 补 30–60 分钟稳态负载，观察内存、连接池、dead/stuck、Provider 429/5xx；
5. 客户要求更高并发时，拆分 API/worker 资源并设置容器 request/limit。
