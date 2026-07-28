# 试点 RC2-X · B2 独立恢复 + R1–R4 故障注入

> 绑定 **RC2-X**（干净工作树上的实际验收运行提交）。S1/S2 见
> [`2026-07-26-pilot-rc-s1-s2.md`](./2026-07-26-pilot-rc-s1-s2.md)。
> 结论：**Conditional GO**（受控试点可继续；**不是**正式 GO）。

## 元数据 / 审计绑定

| 字段 | 值 |
|---|---|
| 原始 structured-retrieval 基线（RC1） | `b98f01438045c92804204449d3172ceb201490e6` |
| 中间产品 harden 提交 | `26e70906cbc17c7955d4b5f71e409ccfb95a6355`（含 `ask.py` / `rag-proxy.ts`） |
| **RC2-X（实际验收运行提交）** | `a79d2a53c5ecb32423dae179bdb05784af187a46` |
| 说明 | 本轮在 **干净工作树**（`git status --porcelain` 为空）上以 `UNORAG_RC_SHA=a79d2a5…` 复跑 B2/R3；结果 JSON 满足 `rc_sha == git_head == script_sha == RC2-X` 且 `git_status_porcelain == ""`。 |
| 报告提交 | `b8223aa9388c5a24f8079602d57da24340f9360c`（仅文档；运行时仍绑 RC2-X `a79d2a5…`） |
| `.b2_last_run.json` sha256 | `58e8635d7a3a27e2e6f9b735e3873533af95a39311da87f8cdff6f6dd6b43f3a` |
| `.r_fault_last_run.json` sha256 | `690fa741e0f3f2f40c5978026bc70d972fb25dc48fb27bfb59024eb8c833cd92` |
| 运行时对齐 | B2/R3：`rc_sha == git_head == script_sha == a79d2a5…`；`git_status_porcelain=""` |
| 拓扑 | **B2**：一次性 Compose 独立项目 + bind 文档目录（**不**触碰主开发 `.unorag` / `unorag_*` 主卷）；**R\***：本机混合栈 `:3000`/`:8000` + Docker Postgres/Qdrant/Redis |
| 日期 | 2026-07-27（RC2-X 证据闭合） |

## B2 — 独立环境恢复

| 字段 | 值 |
|---|---|
| 结果 | **PASS**（RC2-X；真 Qdrant↔PG） |
| 脚本 | [`../../../scripts/acceptance/b2_restore_drill.sh`](../../../scripts/acceptance/b2_restore_drill.sh) |
| 基础设施 | [`../../../scripts/acceptance/compose.b2-infra.yml`](../../../scripts/acceptance/compose.b2-infra.yml) |
| 模式 | `hybrid`：`unorag-b2-src` → backup → destroy → `unorag-b2-dst` restore |
| 备份完成延迟（write→backup complete） | **5 s**（本机实测；**不是** RPO） |
| 本轮数据丢失 | **0**（备份后无写入） |
| 目标 RPO | **未定义**（取决于备份周期/调度；本轮未承诺） |
| RTO（disaster→apps ready） | **22 s** |
| Qdrant↔PG | **exact match**（`qdrant_count=2` / `pg_point_count=2`；org/ws/doc/version/generation/status=active） |

### 流程摘要

1. 独立 Postgres/Qdrant/Redis（端口 `15432/16333/16379`）+ 工作区文档目录（非 `.unorag`）
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
# 须在干净工作树上执行
test -z "$(git status --porcelain)"
UNORAG_RC_SHA=a79d2a53c5ecb32423dae179bdb05784af187a46 \
  ./scripts/acceptance/b2_restore_drill.sh
```

## R1–R4 — 故障注入

| ID | 结果 | 注入 | 预期要点 | 实际摘要 |
|---|---|---|---|---|
| R1 | **PASS** | `SIGTERM` → lifecycle python PID | 任务不丢；恢复后继续 | worker 停期间 job=`queued`；重启后 `completed`（例：`65c666fe-…`） |
| R2 | **PASS**（不复跑） | `docker stop unorag-qdrant-1` | 明确失败/降级，不伪造答案 | health：`qdrant_ok=false`/`degraded`；Ask **503**；无假 citation；已 `docker start` 恢复 |
| R3 | **PASS**（RC2-X 干净树复跑） | `OPENAI_BASE_URL=http://127.0.0.1:1`（临时改 `.env`，EXIT 还原） | 明确错误/拒答 + HTTP/refused/trace；索引不被破坏 | 见下表 |
| R4 | **PASS** | `MINERU_URL=http://127.0.0.1:1` + worker 重启；上传扫描 PDF | 可诊断失败/降级；队列不永久卡住 | job **failed** `stage=parsing` `MinerU unreachable: [Errno 61]`（例 `79ad2fb9-…`）；后续 markdown ingest **completed** |

脚本：[`../../../scripts/acceptance/r_fault_injection.sh`](../../../scripts/acceptance/r_fault_injection.sh)
本地 JSON（勿提交；`0600`）：`scripts/acceptance/.r_fault_last_run.json`。

```bash
test -z "$(git status --porcelain)"
UNORAG_RC_SHA=a79d2a53c5ecb32423dae179bdb05784af187a46 \
  UNORAG_BASE_URL=http://localhost:3000 \
  UNORAG_R_CASES=R3 \
  ./scripts/acceptance/r_fault_injection.sh
```

### R3 复跑结果（RC2-X · `a79d2a5` · 干净工作树）

| 字段 | 值 |
|---|---|
| 状态 | **PASS** |
| `rc_sha` / `git_head` / `script_sha` | 三者均为 `a79d2a53c5ecb32423dae179bdb05784af187a46` |
| `git_status_porcelain` | `""`（空） |
| HTTP / refused / trace | HTTP=**503**；refused=False；err=`ask unavailable: upstream model or embedding failed`；trace/request_id=`0169aa4b-9633-41d1-bd25-28c59df242d4`；path=A |
| 索引完整性 | active document metadata unchanged（`doc_id=14592fb3-0191-4c0a-bbef-d35df6415cff`） |
| 结果 sha256 | `690fa741e0f3f2f40c5978026bc70d972fb25dc48fb27bfb59024eb8c833cd92` |

## 观测（轻量）

见草稿 [`../observability-min-runbook.md`](../observability-min-runbook.md)：`trace_id` → 网关 / 模型 / 检索 / DB / Worker。

## 结论：**Conditional GO**

受控试点可继续；**不是**正式 GO。挡正式 GO 的项见下表。

| 项 | 状态 |
|---|---|
| S1/S2 隔离 | PASS（另文） |
| B2 独立恢复 | **PASS**（RC2-X：备份完成延迟 5s / 丢失 0 / RTO 22s；目标 RPO 未定义；真 Qdrant↔PG exact match；porcelain 空） |
| R1 / R2 / R4 | PASS（本文；**未**重跑 R2） |
| R3（收紧后） | **PASS**（RC2-X 干净树复跑；sha256 已绑） |
| B3/B4 升级/回滚演练 | **PASS**（见 [`2026-07-27-pilot-rc-b3-b4.md`](./2026-07-27-pilot-rc-b3-b4.md)；绑 `88b72d9`） |
| B5 容量/告警接通 | **PASS**（见 [`2026-07-27-pilot-rc-b5-min-alerts.md`](./2026-07-27-pilot-rc-b5-min-alerts.md)；正式签字见 [`2026-07-27-pilot-formal-go-no-go.md`](./2026-07-27-pilot-formal-go-no-go.md)） |
| 完整 Grafana/告警 | 非本轮；仅最低 runbook |
| OIDC / SDK / MCP / 成本面板 | 明确不做 |
| 正式 go/no-go 签字 | 仍待审批人 |

## 建议下一步

1. 把本文 + S1/S2 报告勾进 `pilot-go-no-go-template` 副本，请审批人 **Conditional GO**（勿勾正式 GO）。
2. ~~补 B3/B4~~ → 已闭合，见 [`2026-07-27-pilot-rc-b3-b4.md`](./2026-07-27-pilot-rc-b3-b4.md)。
3. ~~接通 B5 最低告警~~ → 已闭合，见 [`2026-07-27-pilot-rc-b5-min-alerts.md`](./2026-07-27-pilot-rc-b5-min-alerts.md)。正式签字汇总：[`2026-07-27-pilot-formal-go-no-go.md`](./2026-07-27-pilot-formal-go-no-go.md)（**待审批人签字**）。
