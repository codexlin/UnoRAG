# 验收自动化脚本

可重复的试点验收：隔离（S1/S2）、独立恢复（B2）、升级/回滚（B3/B4）、故障注入（R1–R4）。

## 脚本一览

| 脚本 | 覆盖 | 说明 |
|---|---|---|
| [`s1_s2_isolation.sh`](./s1_s2_isolation.sh) | S1/S2 | 多组织/多工作区隔离 |
| [`b2_restore_drill.sh`](./b2_restore_drill.sh) | B2 | 独立 Compose volumes 上 backup→destroy→restore |
| [`b3_b4_upgrade_rollback.sh`](./b3_b4_upgrade_rollback.sh) | B3/B4 | 独立环境升级冒烟 + 应用回滚 / 数据恢复回滚 |
| [`r_fault_injection.sh`](./r_fault_injection.sh) | R1–R4 | Worker / Qdrant / 模型 / MinerU |
| [`b5_min_alerts.sh`](./b5_min_alerts.sh) | B5 | 五信号 → 通用 webhook（本地 mock receiver） |
| [`compose.b2-infra.yml`](./compose.b2-infra.yml) | B2/B3 基建 | 仅 Postgres/Qdrant/Redis；**禁止**指向主开发卷 |
| [`hooks/README.md`](./hooks/README.md) | 索引 | 钩子入口 |

共享辅助：[`lib/common.sh`](./lib/common.sh)。

## 退出码

| 码 | 含义 |
|---|---|
| `0` | **PASS** |
| `1` | **FAIL**（阻断 go） |
| `2` | **BLOCKED/SKIP**（依赖不可用；不算产品 PASS） |

## S1/S2

见历史说明：拓扑 OrgA{A1,A2}+OrgB{B1}；依赖本机混合栈 + embedding/Ask。

```bash
./scripts/acceptance/s1_s2_isolation.sh
```

## B2（独立恢复）

- **不会**对主开发 `.meriknow` 或根 `docker-compose.yml` 卷做 destructive restore。  
- 默认 `hybrid`：独立 project `meriknow-b2-src` / `meriknow-b2-dst` + 临时 API/Worker + Docker `meriknow-web:local`。  
- 需要镜像：`docker build -f deploy/docker/web.Dockerfile -t meriknow-web:local .`  
- 复用 backup/restore 语义（PG → documents → Qdrant）；产物在 `scripts/acceptance/.b2-work/`（gitignore）。

```bash
MERIKNOW_RC_SHA=b98f01438045c92804204449d3172ceb201490e6 \
  ./scripts/acceptance/b2_restore_drill.sh
```

## B3 / B4（升级 + 回滚）

- **不会**触碰主开发 `.meriknow` 或根 `docker-compose.yml` 卷。  
- 独立 project（默认 `meriknow-b3` / `meriknow-b3-restore`）+ 端口 `15532/16433/16479/13001/18001`。  
- **版本策略**：无正式旧镜像时，`MERIKNOW_B3_OLD_SHA`（默认 RC1 `b98f014`）git worktree 跑旧 API；`MERIKNOW_B3_NEW_SHA`/HEAD 为新 API；Web 默认 `meriknow-web:local`。  
- **B3**：旧版 seed → 升级前备份 → migrate → 新版 → smoke（active generation / ACL / Ask / Retrieve / citation / Service Key / lifecycle / Qdrant↔PG）。  
- **B4A**：仅应用回滚（旧 API 接升级后 DB；schema 不兼容则记 FAIL 并继续 B4B）。  
- **B4B**：数据恢复回滚（复用 B2 restore：PG → documents → Qdrant）。  
- 产物：`scripts/acceptance/.b3-work/`、`.b3_b4_last_run.json`（gitignore；`0600`；无完整 key）。

```bash
# 须在干净工作树上执行（证据绑定时）
test -z "$(git status --porcelain)"
MERIKNOW_RC_SHA=a79d2a53c5ecb32423dae179bdb05784af187a46 \
  ./scripts/acceptance/b3_b4_upgrade_rollback.sh

# 可选：只跑部分阶段
MERIKNOW_B3_CASES='B3 B4B' ./scripts/acceptance/b3_b4_upgrade_rollback.sh
```

| 环境变量 | 默认 | 含义 |
|---|---|---|
| `MERIKNOW_B3_OLD_SHA` | `b98f014…` | 旧版本 git commit |
| `MERIKNOW_B3_NEW_SHA` | `HEAD` | 新版本 git commit |
| `MERIKNOW_B3_CASES` | `B3 B4A B4B` | 要跑的阶段 |
| `MERIKNOW_B3_KEEP` | `0` | `1` 保留 workdir/stacks |
| `B3_*_PORT` | 见上 | 端口覆盖 |
| `MERIKNOW_B3_WEB_OLD_TAG` / `_NEW_TAG` | `meriknow-web:local` | Web 镜像标签 |

退出码同表：`0` PASS · `1` FAIL · `2` BLOCKED。

## R1–R4（故障注入）

在**正在运行的混合栈**上注入；R2 会短暂 stop 共享 Qdrant 容器并自动 start；R3/R4 临时改 `apps/api/.env` 并在 EXIT 还原。

```bash
MERIKNOW_BASE_URL=http://localhost:3000 \
  MERIKNOW_RC_SHA=b98f01438045c92804204449d3172ceb201490e6 \
  ./scripts/acceptance/r_fault_injection.sh
```

## B5（最低告警）

- 依赖本机混合栈（web/api + `meriknow-qdrant-1`）与 `DATABASE_URL`。  
- 启动 mock webhook → 对五信号制造故障 → 断言 firing 送达（含定位字段）→ 恢复 → resolved。  
- **不**清空主开发卷；仅短暂 stop/start Qdrant；插入一条标记 stuck job 并在 EXIT 删除。  
- 磁盘：真实 `df` 测量 + `MERIKNOW_ALERT_DISK_FORCE_PERCENT` 注入 webhook 路径（本机不填满磁盘）。  
- 实现：[`../../ops/min_alerts/`](../../ops/min_alerts/)。

```bash
./scripts/acceptance/b5_min_alerts.sh
# 可选：MERIKNOW_B5_CASES='S1 S2' MERIKNOW_B5_KEEP=1
```

## 本地结果文件（勿提交）

- `.s1_s2_last_run.json` / `.isolation-topology.json`  
- `.b2_last_run.json` / `.b2-work/`  
- `.b3_b4_last_run.json` / `.b3-work/`  
- `.b5_last_run.json`  
- `.r_fault_last_run.json`  

## 报告

- [`../../docs/acceptance/reports/2026-07-26-pilot-rc-s1-s2.md`](../../docs/acceptance/reports/2026-07-26-pilot-rc-s1-s2.md)  
- [`../../docs/acceptance/reports/2026-07-26-pilot-rc-b2-r-fault.md`](../../docs/acceptance/reports/2026-07-26-pilot-rc-b2-r-fault.md)  
- [`../../docs/acceptance/reports/2026-07-27-pilot-rc-b3-b4.md`](../../docs/acceptance/reports/2026-07-27-pilot-rc-b3-b4.md)  
- [`../../docs/acceptance/reports/2026-07-27-pilot-rc-b5-min-alerts.md`](../../docs/acceptance/reports/2026-07-27-pilot-rc-b5-min-alerts.md)  
- 观测：[`../../docs/acceptance/observability-min-runbook.md`](../../docs/acceptance/observability-min-runbook.md)  
