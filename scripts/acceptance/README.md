# 验收自动化脚本（S1/S2）

可重复的多组织 / 多工作区隔离验收。绑定试点 RC commit 后执行。

## 拓扑

脚本会创建（并可清理）专用验收拓扑：

```
Organization A
├── Workspace A1  — owner + viewer（restricted ACL 对照）
└── Workspace A2  — owner
Organization B
└── Workspace B1  — owner
```

各工作区上传带唯一 marker 的文档，并创建 Mode B service key。

## 依赖服务

- Next.js 控制面（默认 `http://localhost:3000`，可用 `MERIKNOW_BASE_URL`）
- FastAPI data plane（经 BFF `/api/rag/*` 与 Mode B `/api/v1/*`）
- Postgres（`DATABASE_URL`，通常来自 `apps/web/.env.local`）
- Qdrant + lifecycle worker（文档 ingest 完成）
- 可检索所需的 embedding / Ask 配置（如 `ASK_MODE`、`EMBEDDING_MODEL`、对应 API key）

离线单测不等价于本脚本：`deploy/compose/scripts/pilot-preflight.sh` 只覆盖 Qdrant access-scope 单测 + CI gate。

## 如何运行

```bash
# 仓库根目录
chmod +x scripts/acceptance/s1_s2_isolation.sh

# 可选：固定密码 / 基址 / 保留拓扑
export MERIKNOW_BASE_URL=http://localhost:3000
export MERIKNOW_ISOLATION_PASSWORD='IsolationPilot!2026'
# export MERIKNOW_ISOLATION_KEEP=1   # 跑完不删 Org A/B
# export MERIKNOW_RC_SHA=$(git rev-parse HEAD)

./scripts/acceptance/s1_s2_isolation.sh
```

仅建/清拓扑：

```bash
node scripts/acceptance/bootstrap_isolation_topology.mjs
node scripts/acceptance/bootstrap_isolation_topology.mjs --cleanup
```

## 退出码

| 码 | 含义 |
|---|---|
| `0` | **PASS** — S1/S2 自动化探针全过 |
| `1` | **FAIL** — 发现泄漏或产品错误 |
| `2` | **BLOCKED/SKIP** — 服务/DB/embedding 不可用；不算产品 PASS |

最近一次结果写在 `scripts/acceptance/.s1_s2_last_run.json`（已 gitignore 建议本地保留）。

## 覆盖项

- S2：A1 用户/Key 无法召回 A2 / B1 marker（session Ask + Mode B ask/retrieve；含外键 `library_id`）
- S1：B1 无法召回 A1；文档 / Library / archive / archive debug IDOR
- Restricted ACL：仅指定 principal 可见；viewer 不可见
- Replace / Delete API（A2 文档）及删除后不可召回

## 下一步钩子（本目录不实现完整演练）

见 [`hooks/README.md`](./hooks/README.md)：B2 restore、R1–R4 故障注入、观测。
