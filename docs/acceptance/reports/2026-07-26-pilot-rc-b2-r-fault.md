# 试点 RC · B2 独立恢复 + R1–R4 故障注入

> 绑定 structured-retrieval pilot RC。S1/S2 见  
> [`2026-07-26-pilot-rc-s1-s2.md`](./2026-07-26-pilot-rc-s1-s2.md)。  
> 结论：**Conditional GO**（受控试点可继续；**不是**正式 GO）。

## 元数据 / 审计绑定

| 字段 | 值 |
|---|---|
| Pilot RC（代码基线） | `b98f01438045c92804204449d3172ceb201490e6` |
| HEAD（harden 后） | `a60df51d98ebad0ea2d5706c11fe5ac9ddd6296c`（已 push `origin/main`） |
| B2 script sha | _（B2 复跑后填 `script_sha`）_ |
| R-fault script sha | `a60df51d98ebad0ea2d5706c11fe5ac9ddd6296c` |
| `.b2_last_run.json` sha256 | _（B2 复跑后填）_ |
| `.r_fault_last_run.json` sha256 | `6bedb3c0da288284658567db8fa254a6b724697be00aad0d9f3516c4e8268e3f` |
| 拓扑 | **B2**：一次性 Compose 独立项目 + bind 文档目录（**不**触碰主开发 `.meriknow` / `meriknow_*` 主卷）；**R\***：本机混合栈 `:3000`/`:8000` + Docker Postgres/Qdrant/Redis |
| 日期 | 2026-07-26 |

## B2 — 独立环境恢复

| 字段 | 值 |
|---|---|
| 结果 | **PASS**（上一轮证据；harden 后待复跑确认真 Qdrant↔PG） |
| 脚本 | [`../../../scripts/acceptance/b2_restore_drill.sh`](../../../scripts/acceptance/b2_restore_drill.sh) |
| 基础设施 | [`../../../scripts/acceptance/compose.b2-infra.yml`](../../../scripts/acceptance/compose.b2-infra.yml) |
| 模式 | `hybrid`：`meriknow-b2-src` → backup → destroy → `meriknow-b2-dst` restore |
| 备份完成延迟（write→backup complete） | **5 s**（本机实测；**不是** RPO） |
| 本轮数据丢失 | **0**（备份后无写入） |
| 目标 RPO | **未定义**（取决于备份周期/调度；本轮未承诺） |
| RTO（disaster→apps ready） | **48 s**（有证据：`timing.rto`） |

### 流程摘要

1. 独立 Postgres/Qdrant/Redis（端口 `15432/16333/16379`）+ 工作区文档目录（非 `.meriknow`）  
2. migrate + bootstrap → 上传 → replace 新版本 → restricted ACL + reindex → service key → Ask → archive thread  
3. backup：`postgres.sql` + `documents.tgz` + `qdrant.tgz` + `MANIFEST.txt`  
4. 销毁源 project volumes → 目标 project restore（顺序：PG → documents → Qdrant）→ 再拉起应用  
5. 校验：health、对象文件数、active version/generation、ACL 未扩大、members、service key 仍在、session Ask/Retrieve 含 marker+citation、Mode B 密钥可认证、**Qdrant↔PG 精确比对**（非仅 collection count>0）  

本地 JSON（勿提交；`0600`）：`scripts/acceptance/.b2_last_run.json`（仅 `service_key_id` / `service_key_last4`，无完整 key）。

### Service key 卫生

- `.b2-work/**/*.json` 与 last_run：已脱敏（无完整 `service_key`）。  
- `.gitignore` 已忽略 `.b2-work/`、`*_last_run.json` 及其 sha256。  
- 吊销：主库 `app.workspace_service_keys` 查无 B2 key id `0a2fd7c9-…`（last4 `Pzau`）——B2 一次性 Postgres 已销毁；主库现有 2 把 key 均已 `revoked`；无完整 key 可调 API。  

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
| R2 | **PASS**（不复跑） | `docker stop meriknow-qdrant-1` | 明确失败/降级，不伪造答案 | health：`qdrant_ok=false`/`degraded`；Ask **503**；无假 citation；已 `docker start` 恢复 |
| R3 | **PASS**（harden 后复跑） | `OPENAI_BASE_URL=http://127.0.0.1:1`（临时改 `.env`，EXIT 还原） | 明确错误/拒答 + HTTP/refused/trace；索引不被破坏 | HTTP **503**；`refused=false`；err=`ask unavailable: upstream model or embedding failed`；trace=`c9c26b27-…`；index intact `61e66df8-…` |
| R4 | **PASS** | `MINERU_URL=http://127.0.0.1:1` + worker 重启；上传扫描 PDF | 可诊断失败/降级；队列不永久卡住 | job **failed** `stage=parsing` `MinerU unreachable: [Errno 61]`（例 `79ad2fb9-…`）；后续 markdown ingest **completed** |

脚本：[`../../../scripts/acceptance/r_fault_injection.sh`](../../../scripts/acceptance/r_fault_injection.sh)  
本地 JSON（勿提交；`0600`）：`scripts/acceptance/.r_fault_last_run.json`。

```bash
MERIKNOW_RC_SHA=b98f01438045c92804204449d3172ceb201490e6 \
  MERIKNOW_BASE_URL=http://localhost:3000 \
  MERIKNOW_R_CASES=R3 \
  ./scripts/acceptance/r_fault_injection.sh
```

### R3 复跑结果（harden 后 · `a60df51`）

| 字段 | 值 |
|---|---|
| 状态 | **PASS** |
| HTTP / refused / trace | HTTP=503；refused=False；refuse_reason=`ask unavailable: upstream model or embedding failed`；trace/request_id=`c9c26b27-3f38-4ba3-ba8d-0578bfa02929`；path=A |
| 索引完整性 | active document metadata unchanged（`doc_id=61e66df8-7266-4dd6-b63c-c643d1b98f8f`） |
| 结果 sha256 | `6bedb3c0da288284658567db8fa254a6b724697be00aad0d9f3516c4e8268e3f` |

## 观测（轻量）

见草稿 [`../observability-min-runbook.md`](../observability-min-runbook.md)：`trace_id` → 网关 / 模型 / 检索 / DB / Worker。

## 结论：**Conditional GO**

受控试点可继续；**不是**正式 GO。挡正式 GO 的项见下表。

| 项 | 状态 |
|---|---|
| S1/S2 隔离 | PASS（另文） |
| B2 独立恢复 | PASS（指标：备份完成延迟 / 丢失 0 / RTO；目标 RPO 未定义）；harden 后 Qdrant↔PG 待复跑确认 |
| R1 / R2 / R4 | PASS（本文；**禁止**无必要重跑 R2） |
| R3（收紧后） | **PASS**（复跑证据见上；sha256 已绑） |
| B3/B4 升级/回滚演练 | 仍缺 |
| B5 容量/告警接通 | 仍缺（仅有观测草稿） |
| 完整 Grafana/告警 | 非本轮；仅最低 runbook |
| OIDC / SDK / MCP / 成本面板 | 明确不做 |
| 正式 go/no-go 签字 | 仍待审批人 |

## 建议下一步

1. 把本文 + S1/S2 报告勾进 `pilot-go-no-go-template` 副本，请审批人 **Conditional GO**（勿勾正式 GO）。  
2. 补 B3 升级冒烟（`upgrade.sh`）与书面回滚。  
3. 按观测草稿接最少告警：worker heartbeat 缺失、Qdrant health、Ask 5xx、dead job 增长。  
