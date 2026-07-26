# 验收自动化脚本

可重复的试点验收：隔离（S1/S2）、独立恢复（B2）、故障注入（R1–R4）。

## 脚本一览

| 脚本 | 覆盖 | 说明 |
|---|---|---|
| [`s1_s2_isolation.sh`](./s1_s2_isolation.sh) | S1/S2 | 多组织/多工作区隔离 |
| [`b2_restore_drill.sh`](./b2_restore_drill.sh) | B2 | 独立 Compose volumes 上 backup→destroy→restore |
| [`r_fault_injection.sh`](./r_fault_injection.sh) | R1–R4 | Worker / Qdrant / 模型 / MinerU |
| [`compose.b2-infra.yml`](./compose.b2-infra.yml) | B2 基建 | 仅 Postgres/Qdrant/Redis；**禁止**指向主开发卷 |
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

## R1–R4（故障注入）

在**正在运行的混合栈**上注入；R2 会短暂 stop 共享 Qdrant 容器并自动 start；R3/R4 临时改 `apps/api/.env` 并在 EXIT 还原。

```bash
MERIKNOW_BASE_URL=http://localhost:3000 \
  MERIKNOW_RC_SHA=b98f01438045c92804204449d3172ceb201490e6 \
  ./scripts/acceptance/r_fault_injection.sh
```

## 本地结果文件（勿提交）

- `.s1_s2_last_run.json` / `.isolation-topology.json`  
- `.b2_last_run.json` / `.b2-work/`  
- `.r_fault_last_run.json`  

## 报告

- [`../../docs/acceptance/reports/2026-07-26-pilot-rc-s1-s2.md`](../../docs/acceptance/reports/2026-07-26-pilot-rc-s1-s2.md)  
- [`../../docs/acceptance/reports/2026-07-26-pilot-rc-b2-r-fault.md`](../../docs/acceptance/reports/2026-07-26-pilot-rc-b2-r-fault.md)  
- 观测草稿：[`../../docs/acceptance/observability-min-runbook.md`](../../docs/acceptance/observability-min-runbook.md)  
