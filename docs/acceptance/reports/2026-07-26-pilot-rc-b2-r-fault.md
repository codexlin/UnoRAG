# 试点 RC · B2 独立恢复 + R1–R4 故障注入

> 绑定 structured-retrieval pilot RC。S1/S2 见  
> [`2026-07-26-pilot-rc-s1-s2.md`](./2026-07-26-pilot-rc-s1-s2.md)。

## 元数据

| 字段 | 值 |
|---|---|
| Pilot RC（代码基线） | `b98f01438045c92804204449d3172ceb201490e6` |
| 脚本/证据 commit | `1cfa06359179e519097c63b26c9d6caa227d0d8e`（已 push；本地 JSON `script_sha` 为跑测时 HEAD，可能略早） |
| 拓扑 | **B2**：一次性 Compose 独立项目 + bind 文档目录（**不**触碰主开发 `.meriknow` / `meriknow_*` 主卷）；**R\***：本机混合栈 `:3000`/`:8000` + Docker Postgres/Qdrant/Redis |
| 日期 | 2026-07-26 |

## B2 — 独立环境恢复

| 字段 | 值 |
|---|---|
| 结果 | **PASS** |
| 脚本 | [`../../../scripts/acceptance/b2_restore_drill.sh`](../../../scripts/acceptance/b2_restore_drill.sh) |
| 基础设施 | [`../../../scripts/acceptance/compose.b2-infra.yml`](../../../scripts/acceptance/compose.b2-infra.yml) |
| 模式 | `hybrid`：`meriknow-b2-src` → backup → destroy → `meriknow-b2-dst` restore |
| RPO（write→backup complete） | **~4–5 s**（本机实测；无备份后写入） |
| RTO（disaster→apps ready） | **~21–48 s**（含 Postgres/Qdrant restore + 临时 API/Web/Worker 拉起） |

### 流程摘要

1. 独立 Postgres/Qdrant/Redis（端口 `15432/16333/16379`）+ 工作区文档目录（非 `.meriknow`）  
2. migrate + bootstrap → 上传 → replace 新版本 → restricted ACL + reindex → service key → Ask → archive thread  
3. backup：`postgres.sql` + `documents.tgz` + `qdrant.tgz` + `MANIFEST.txt`  
4. 销毁源 project volumes → 目标 project restore（顺序：PG → documents → Qdrant）→ 再拉起应用  
5. 校验：health、对象文件数、active version/generation、ACL 未扩大、members、service key 仍在、session Ask/Retrieve 含 marker+citation、Mode B 密钥可认证、Qdrant collection 非空  

本地 JSON（勿提交）：`scripts/acceptance/.b2_last_run.json`。

复跑：

```bash
# 需已有 meriknow-web:local（本轮已构建）
MERIKNOW_RC_SHA=b98f01438045c92804204449d3172ceb201490e6 \
  ./scripts/acceptance/b2_restore_drill.sh
```

## R1–R4 — 故障注入

| ID | 结果 | 注入 | 预期要点 | 实际摘要 |
|---|---|---|---|---|
| R1 | **PASS** | `SIGTERM` → lifecycle python PID | 任务不丢；恢复后继续 | worker 停期间 job=`queued`；重启后 `completed`（例：`65c666fe-…`） |
| R2 | **PASS** | `docker stop meriknow-qdrant-1` | 明确失败/降级，不伪造答案 | health：`qdrant_ok=false`/`degraded`；Ask **503**（live requires reachable Qdrant）；无假 citation；已 `docker start` 恢复 |
| R3 | **PASS** | `OPENAI_BASE_URL=http://127.0.0.1:1`（临时改 `.env`，EXIT 还原） | 明确错误/拒答；索引不被破坏 | Ask 非正常成功应答；`active_version_id`/generation 不变（例 doc `d199f4cf-…`） |
| R4 | **PASS** | `MINERU_URL=http://127.0.0.1:1` + worker 重启；上传扫描 PDF | 可诊断失败/降级；队列不永久卡住 | job **failed** `stage=parsing` `MinerU unreachable: [Errno 61]`（例 `79ad2fb9-…`）；后续 markdown ingest **completed** |

脚本：[`../../../scripts/acceptance/r_fault_injection.sh`](../../../scripts/acceptance/r_fault_injection.sh)  
本地 JSON（勿提交）：`scripts/acceptance/.r_fault_last_run.json`。

```bash
MERIKNOW_RC_SHA=b98f01438045c92804204449d3172ceb201490e6 \
  MERIKNOW_BASE_URL=http://localhost:3000 \
  ./scripts/acceptance/r_fault_injection.sh
# 可选：MERIKNOW_R_CASES='R1 R2'
```

## 观测（轻量）

见草稿 [`../observability-min-runbook.md`](../observability-min-runbook.md)：`trace_id` → 网关 / 模型 / 检索 / DB / Worker。

## 相对「受控试点 GO」仍缺

| 项 | 状态 |
|---|---|
| S1/S2 隔离 | PASS（另文） |
| B2 独立恢复 | **PASS（本文）** |
| R1–R4 | **PASS（本文）** |
| B3/B4 升级/回滚演练 | 仍缺 |
| B5 容量/告警接通 | 仍缺（仅有观测草稿） |
| 完整 Grafana/告警 | 非本轮；仅最低 runbook |
| OIDC / SDK / MCP / 成本面板 | 明确不做 |
| 正式 go/no-go 签字 | 仍待审批人 |

## 建议下一步

1. 把本文 + S1/S2 报告勾进 `pilot-go-no-go-template` 副本，请审批人条件 GO / GO。  
2. 补 B3 升级冒烟（`upgrade.sh`）与书面回滚。  
3. 按观测草稿接最少告警：worker heartbeat 缺失、Qdrant health、Ask 5xx、dead job 增长。  
