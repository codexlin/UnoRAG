# 试点 RC2 · B2 独立恢复 + R1–R4 故障注入

> 绑定 **RC2**（实际验收运行提交）。S1/S2 见  
> [`2026-07-26-pilot-rc-s1-s2.md`](./2026-07-26-pilot-rc-s1-s2.md)。  
> 结论：**Conditional GO**（受控试点可继续；**不是**正式 GO）。

## 元数据 / 审计绑定

| 字段 | 值 |
|---|---|
| 原始 structured-retrieval 基线（RC1） | `b98f01438045c92804204449d3172ceb201490e6` |
| **RC2（实际验收运行提交）** | `26e70906cbc17c7955d4b5f71e409ccfb95a6355` |
| 说明 | `b98f014..26e7090` 含产品改动：`apps/api/app/routers/ask.py`、`apps/web/src/lib/server/rag-proxy.ts`（harden：错误关联 / request id）。最新 PASS 证明的是 **RC2**，不是 RC1。 |
| 证据收口 commit | `21c61682e122714a44d70d39889663020adf4819`（本报告 + 脚本默认 rc_sha=HEAD） |
| B2/R 脚本默认 `rc_sha` | 默认 `git rev-parse HEAD`；本轮显式 `MERIKNOW_RC_SHA=26e7090…` |
| `.b2_last_run.json` sha256 | `ec8fb1d4c11d2daf5f424ac17ce6d08828c03d4caf4d6ee61b71b0bbf2194805` |
| `.r_fault_last_run.json` sha256 | `dc8d53b1d46730132f8917a9db701d5e750b1acddc3888735a95b11504a61287` |
| 运行时对齐 | B2/R3：`rc_sha == git_head == script_sha == 26e7090…` |
| 拓扑 | **B2**：一次性 Compose 独立项目 + bind 文档目录（**不**触碰主开发 `.meriknow` / `meriknow_*` 主卷）；**R\***：本机混合栈 `:3000`/`:8000` + Docker Postgres/Qdrant/Redis |
| 日期 | 2026-07-27（RC2 证据收口） |

## B2 — 独立环境恢复

| 字段 | 值 |
|---|---|
| 结果 | **PASS**（RC2；真 Qdrant↔PG） |
| 脚本 | [`../../../scripts/acceptance/b2_restore_drill.sh`](../../../scripts/acceptance/b2_restore_drill.sh) |
| 基础设施 | [`../../../scripts/acceptance/compose.b2-infra.yml`](../../../scripts/acceptance/compose.b2-infra.yml) |
| 模式 | `hybrid`：`meriknow-b2-src` → backup → destroy → `meriknow-b2-dst` restore |
| 备份完成延迟（write→backup complete） | **4 s**（本机实测；**不是** RPO） |
| 本轮数据丢失 | **0**（备份后无写入） |
| 目标 RPO | **未定义**（取决于备份周期/调度；本轮未承诺） |
| RTO（disaster→apps ready） | **20 s**（本轮证据；此前 harden 轮曾观测 22 s / 48 s） |
| Qdrant↔PG | **exact match**（`qdrant_count=2` / `pg_point_count=2`；org/ws/doc/version/generation/status=active） |

### 流程摘要

1. 独立 Postgres/Qdrant/Redis（端口 `15432/16333/16379`）+ 工作区文档目录（非 `.meriknow`）  
2. migrate + bootstrap → 上传 → replace 新版本 → restricted ACL + reindex → service key → Ask → archive thread  
3. backup：`postgres.sql` + `documents.tgz` + `qdrant.tgz` + `MANIFEST.txt`  
4. 销毁源 project volumes → 目标 project restore（顺序：PG → documents → Qdrant）→ 再拉起应用  
5. 校验：health、对象文件数、active version/generation、ACL 未扩大、members、service key 仍在、session Ask/Retrieve 含 marker+citation、Mode B 密钥可认证、**Qdrant↔PG 精确比对**  

本地 JSON（勿提交；`0600`）：`scripts/acceptance/.b2_last_run.json`（仅 `service_key_id` / `service_key_last4`，无完整 key）。

### Service key 卫生

- `.b2-work/**/*.json` 与 last_run：已脱敏（无完整 `service_key`）。  
- `.gitignore` 已忽略 `.b2-work/`、`*_last_run.json` 及其 sha256。  
- 吊销：B2 一次性 Postgres 跑完即销毁；主库测试 key 已清理/revoked。  

复跑：

```bash
MERIKNOW_RC_SHA=26e70906cbc17c7955d4b5f71e409ccfb95a6355 \
  ./scripts/acceptance/b2_restore_drill.sh
```

## R1–R4 — 故障注入

| ID | 结果 | 注入 | 预期要点 | 实际摘要 |
|---|---|---|---|---|
| R1 | **PASS** | `SIGTERM` → lifecycle python PID | 任务不丢；恢复后继续 | worker 停期间 job=`queued`；重启后 `completed`（例：`65c666fe-…`） |
| R2 | **PASS**（不复跑） | `docker stop meriknow-qdrant-1` | 明确失败/降级，不伪造答案 | health：`qdrant_ok=false`/`degraded`；Ask **503**；无假 citation；已 `docker start` 恢复 |
| R3 | **PASS**（RC2 收口复跑） | `OPENAI_BASE_URL=http://127.0.0.1:1`（临时改 `.env`，EXIT 还原） | 明确错误/拒答 + HTTP/refused/trace；索引不被破坏 | 见下表 |
| R4 | **PASS** | `MINERU_URL=http://127.0.0.1:1` + worker 重启；上传扫描 PDF | 可诊断失败/降级；队列不永久卡住 | job **failed** `stage=parsing` `MinerU unreachable: [Errno 61]`（例 `79ad2fb9-…`）；后续 markdown ingest **completed** |

脚本：[`../../../scripts/acceptance/r_fault_injection.sh`](../../../scripts/acceptance/r_fault_injection.sh)  
本地 JSON（勿提交；`0600`）：`scripts/acceptance/.r_fault_last_run.json`。

```bash
MERIKNOW_RC_SHA=26e70906cbc17c7955d4b5f71e409ccfb95a6355 \
  MERIKNOW_BASE_URL=http://localhost:3000 \
  MERIKNOW_R_CASES=R3 \
  ./scripts/acceptance/r_fault_injection.sh
```

### R3 复跑结果（RC2 收口 · `26e7090`）

| 字段 | 值 |
|---|---|
| 状态 | **PASS** |
| `rc_sha` / `git_head` / `script_sha` | 三者均为 `26e70906cbc17c7955d4b5f71e409ccfb95a6355` |
| HTTP / refused / trace | HTTP=**503**；refused=False；err=`ask unavailable: upstream model or embedding failed`；trace/request_id=`22a26731-6286-4a27-852f-857ce4b12e8d`；path=A |
| 索引完整性 | active document metadata unchanged（`doc_id=25a59960-8974-4ce6-a810-6181a453f6e2`） |
| 结果 sha256 | `dc8d53b1d46730132f8917a9db701d5e750b1acddc3888735a95b11504a61287` |

## 观测（轻量）

见草稿 [`../observability-min-runbook.md`](../observability-min-runbook.md)：`trace_id` → 网关 / 模型 / 检索 / DB / Worker。

## 结论：**Conditional GO**

受控试点可继续；**不是**正式 GO。挡正式 GO 的项见下表。

| 项 | 状态 |
|---|---|
| S1/S2 隔离 | PASS（另文；仍可绑 RC1/后续拓扑） |
| B2 独立恢复 | **PASS**（RC2：备份完成延迟 4s / 丢失 0 / RTO 20s；目标 RPO 未定义；真 Qdrant↔PG exact match） |
| R1 / R2 / R4 | PASS（本文；**未**重跑 R2） |
| R3（收紧后） | **PASS**（RC2 收口复跑；sha256 已绑） |
| B3/B4 升级/回滚演练 | 仍缺 |
| B5 容量/告警接通 | 仍缺（仅有观测草稿） |
| 完整 Grafana/告警 | 非本轮；仅最低 runbook |
| OIDC / SDK / MCP / 成本面板 | 明确不做 |
| 正式 go/no-go 签字 | 仍待审批人 |

## 建议下一步

1. 把本文 + S1/S2 报告勾进 `pilot-go-no-go-template` 副本，请审批人 **Conditional GO**（勿勾正式 GO）。  
2. 补 B3 升级冒烟（`upgrade.sh`）与书面回滚。  
3. 按观测草稿接最少告警：worker heartbeat 缺失、Qdrant health、Ask 5xx、dead job 增长。  
