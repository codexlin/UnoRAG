# Private stack fault matrix + backup/restore — `29b06fe`

| 项 | 值 |
|----|----|
| 日期 | 2026-07-27 |
| 发布候选 / 远端 tip SHA | `29b06feef67923e254d3167b486be459f3c0ca8c` |
| 拓扑 | Compose `unorag-private` · `HTTP_PORT=8088` · 含 **outbox-worker** |
| 结论（本切片） | **PASS** — 故障矩阵 4/4；备份→破坏→恢复→冒烟 PASS |
| 明确跳过 | 24–72h soak（按授权不做） |
| 前置 | 补齐黑盒报告 [`2026-07-27-private-0170ba8-blackbox.md`](./2026-07-27-private-0170ba8-blackbox.md) 未覆盖项 |

## 0. Push

| 项 | 值 |
|----|----|
| 本地领先 | `29b06fe`（Step 1 收敛）ahead of `1ffffab` |
| 操作 | `git push -u origin HEAD`（非 force） |
| `origin/main` tip | `29b06feef67923e254d3167b486be459f3c0ca8c` |

## 1. 故障矩阵（真实私有栈）

操作约定：`cd deploy/compose && source scripts/compose-env.sh` 后使用 `mk_compose`。
证据目录（本机，勿提交）：`/tmp/unorag-fault-29b06fe/`（`checks.jsonl`、`run.log`、各 ask/health JSON）。

| ID | 场景 | 结果 | 证据摘要 |
|----|------|------|----------|
| F1 | Qdrant 停 / 不可达 → Ask/retrieve 失败语义；恢复后可用 | **PASS** | `mk_compose stop qdrant` → health `qdrant_ok=false`/`degraded`/`ask_ready=false`；Ask **503**（`ask unavailable: … reachable Qdrant`）；retrieve **503**；`start qdrant` 后 Ask **200** |
| F2 | 模型不可用（`LLM_BASE_URL=http://127.0.0.1:1` + recreate api） | **PASS** | Ask **503** `error_code=llm_upstream_unavailable` / `upstream model or embedding failed`；无 citation 胡答；还原 `runtime.env` + recreate 后 Ask **200** 且 marker/`BLUEBIRD42` 可答；文档仍 `ready` |
| F3 | Job cancel / retry | **PASS** | worker 停时上传 → status=`queued`；`POST /api/jobs/{id}/cancel` → **200** `cancelled`；`POST …/retry` → **202** 新 job `queued`；后续正常 markdown ingest **completed** |
| F4 | 旧版本 serving / 激活切换不串库 | **PASS** | `POST …/documents/{id}/versions` 替换后 Ask **200**；答案含 `VERSION_TWO_BETA_*` / `BETA_VEGETABLE`；citations 仅 `document_version_id=v2`（非 v1） |

### F3 备注

- Cancel（queued）行为正确。
- Retry cancelled：API 接受并返回新 queued job（本轮 HTTP 202）。
- 「极短文件」本轮被解析为 completed（不足以作为 failed→retry 种子）；failed→retry 路径未单独打红，cancel + retry 入队 + 后续 ingest 已覆盖主路径。

### Soak

| 项 | 结果 |
|----|------|
| 24–72h 长稳 | **SKIP**（授权跳过） |

## 2. 备份 / 恢复

清单：[`../backup-restore-verification.md`](../backup-restore-verification.md)。
备份目录（gitignore，本机）：`deploy/compose/backups/pilot-29b06fe-20260727T235730/`。
证据：`/tmp/unorag-backup-29b06fe/`。

| 步骤 | 结果 | 证据 |
|------|------|------|
| 备份前对照 | PASS | lib=`067c900a-…` doc=`4ee2ca2a-…` ver=`46983f9b-…` gen=`914bb3c7-…` marker=`BACKUP_CONTROL_MARKER_1785167845_3066`；Ask 基线含 marker |
| `./scripts/backup.sh` | PASS | `postgres.sql` 269KB · `documents.tgz` 229KB · `qdrant.tgz` 3.1MB · `MANIFEST.txt`（project=`unorag-private`） |
| 备份后毒丸文档 | PASS | doc=`aa28c403-…` marker=`SHOULD_DISAPPEAR_…` ingest completed；恢复前库内 2 docs |
| 恢复 | PASS* | 见下「修复」；顺序 PG → documents → Qdrant → 启 app（含 outbox-worker） |
| 恢复后一致性 | PASS | 对照 doc 仍在且 `ready`/chunks=6；ver/gen 与备份前一致；毒丸 doc **消失**；health `ok`/`ask_ready`；Ask 返 marker；citation `document_version_id=46983f9b-…` |
| Redis | PASS（设计） | 未从备份恢复 |

### 恢复脚本修复（本轮发现并落地）

首次 `CONFIRM=YES ./scripts/restore.sh` **失败**：`ERROR: schema "drizzle" already exists`（脚本只 drop `app`/`rag`/`public`）。

已修 `deploy/compose/scripts/restore.sh`：

1. `DROP SCHEMA IF EXISTS drizzle CASCADE`
2. stop/start 纳入 **outbox-worker**（与私有部署 runbook 一致）

修后重跑恢复验证 **PASS**。

## 3. 总表

| 项 | 结果 |
|----|------|
| Push `origin/main` @ `29b06fe` | PASS |
| F1 Qdrant | PASS |
| F2 模型不可用 | PASS |
| F3 cancel/retry | PASS |
| F4 版本切换 | PASS |
| 备份→破坏→恢复→冒烟 | PASS |
| Soak | SKIP |

## 4. 建议

1. 合并/发布前确认客户卷上已用含 `drizzle` drop 的 `restore.sh`（否则裸脚本会卡在 PG restore）。
2. 可选：补一条「故意 failed job → retry」用例（用确定会 `invalid_document` 的夹具），强化 F3。
3. 正式 go/no-go 仍待：TLS / 告警 webhook 签字、soak（若生产要求）、审批人签字稿。
