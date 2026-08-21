# UnoRAG v0.1.0-rc.14 COS 与容量基线

- 日期：2026-08-22（Asia/Shanghai）
- 提交：`ab0ea094df2cfee5d226d0d912928203c15def9b`
- 发布：[`v0.1.0-rc.14`](https://github.com/codexlin/UnoRAG/releases/tag/v0.1.0-rc.14)
- 环境：UnoRAG-HK，公网 `https://unorag.unobyte.dev`
- 主机：约 4 GiB RAM、2 GiB Swap
- 结论：**空环境 COS 安装、产品全链路、阶梯并发和真实 MinerU 图表 PDF 全部 PASS**

## 空环境与 COS

验收前确认旧环境的产品 API 已无可见知识库；历史 PostgreSQL、Qdrant、Redis 和本地文档卷均为
测试残留。保留升级前一致性备份后，删除旧数据卷并使用 RC.14 digest manifest 完成空环境安装，
重新 bootstrap organization、workspace 和 administrator。

`DOCUMENT_STORAGE_DRIVER=cos` 同时注入 Web 和 DBOS Worker。通过公网产品边界完成
upload -> index -> Ask -> Public Retrieve/Ask -> service-key scope/revoke -> library isolation ->
replace -> delete，全部通过。该结果证明应用读写链路使用 COS，不只是独立 SDK 连通性探针。

安装后的 lifecycle 巡检中，dead、stuck、deleting、cleanup error、pending ACL projection 和过期
tombstone 均为 0。

## 受控容量基线

容量脚本从独立客户端通过公网 HTTPS 运行，创建隔离知识库和 service key；结束后自动撤销 key 并
删除测试知识库。测试语料使用唯一 marker，每个成功请求还必须在 citation 中命中 marker，不能只以
HTTP 200 判定成功。

### Retrieve

| 并发 | 请求 | 成功 / 质量通过 | 吞吐 RPS | P50 | P95 | P99 |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 5 | 5 / 5 | 0.498 | 1.951s | 2.128s | 2.128s |
| 5 | 10 | 10 / 10 | 2.217 | 2.184s | 2.315s | 2.315s |
| 10 | 20 | 20 / 20 | 4.531 | 2.105s | 2.308s | 2.318s |
| 20 | 40 | 40 / 40 | 6.715 | 2.367s | 2.727s | 3.485s |

共 75 次请求，0 HTTP failure、0 quality failure。当前小语料下并发 20 仍保持稳定；约 2 秒的基础
延迟主要包含外部 query embedding，不能视为 Qdrant 本地检索耗时。

### Ask

| 并发 | 请求 | 成功 / 质量通过 | 吞吐 RPS | P50 | P95 | P99 |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 2 | 2 / 2 | 0.130 | 7.149s | 8.242s | 8.242s |
| 5 | 5 | 5 / 5 | 0.614 | 6.978s | 8.138s | 8.138s |
| 10 | 10 | 10 / 10 | 1.156 | 7.190s | 8.617s | 8.617s |
| 20 | 20 | 20 / 20 | 2.031 | 8.303s | 8.783s | 9.803s |

共 37 次请求，0 HTTP failure、0 quality failure、0 错误拒答。并发 20 的尾延迟仍低于 10 秒，
但结果同时受模型供应商容量、响应长度和当前短语料影响。

### 入库生命周期

| 并发任务 | 完成 | 失败 | 接受 P95 | Ready P50 | Ready P95 |
|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 0 | 1.842s | 6.725s | 6.725s |
| 2 | 2 | 0 | 1.803s | 5.373s | 7.131s |
| 4 | 4 | 0 | 2.229s | 11.295s | 14.966s |

并发 4 时出现预期排队，但 4/4 均在 15 秒内完成。当前部署配置为 local/auto/MinerU Worker 并发
`2/1/1`，因此不能从这组短 Markdown 结果外推扫描 PDF 的吞吐。

## 真实 MinerU 探针

`testdata/ab/mixed-charts.pdf`（330,326 bytes）经公网产品 API 上传并保存到 COS，随后通过
`302ai` MinerU 完成 structured 解析和索引：

- 状态：`completed / done`
- 总 Ready：26.247s
- parser：`mineru`
- provider：`302ai`
- mode：`structured`
- partial：`false`
- warnings：0

## 资源与边界

压测期间主机内存约使用 1.1/3.8 GiB，Swap 仅约 268 KiB。Web 约 161 MiB，Worker 约 123 MiB，
PostgreSQL 约 67 MiB，未观察到主机 CPU、内存或磁盘压力。最终健康状态为
`live_ready=true`、`ask_ready=true`、`degraded=false`。

这是一组受控基线，不是最大容量证明，也不是长时间 soak：语料很小、运行约两分钟、单 Web 和单
Worker，且模型与 MinerU 为外部 Provider。百万级 Chunk、持续写入、Provider 限流和多副本扩展仍需
在对应目标环境单独测试。

## 发现与后续动作

部署配置中的 `LLM_MAX_INFLIGHT=2` 当前未被 TypeScript Ask 运行时消费。Provider 在本次并发 20
测试中没有报错，但这不等于系统已经具备应用级模型背压。下一版本应在共享 AI Provider 边界加入
abort-aware 并发门控，并记录等待时长、in-flight、429 和 timeout 指标；然后复跑相同阶梯，确认门控
只增加可解释的排队延迟，不降低 citation 质量。

原始 JSON 报告保存在本地 gitignored 的 `scripts/acceptance/.capacity_rc14_cos*.json`，不包含管理员
密码或 service key。本报告仅证明上述 commit、镜像、配置和测试窗口。
