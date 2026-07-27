# MeriKnow 收敛计划（Step 2：Eval → AskGraph 无行为变化拆分）

> 状态：**Step 1 已完成**（2026-07-27）；**Step 2 进行中**（2026-07-28）— **先 Eval，后 AskGraph**（两模块不同 PR）。
> 前提：私有栈黑盒 [Conditional PASS @ `0170ba8`](../acceptance/reports/2026-07-27-private-0170ba8-blackbox.md)；试点 **Conditional GO @ webch**。
> **当前**：Eval 无行为变化拆分 **已完成**；AskGraph 提交 1–7（含 `AskGraphService`：prepare→execute→finalize）**已完成** → **AskGraph Step 2 主线完成**。
> 约束：无行为变化；旧 import 过渡期仍可用；每提交 release gate 绿；不删 410 内部实现、不做 codegen、不扩消融/OpenAI。

---

## 1. 现状判定

架构分层（Workspace 客户端 → Knowledge API 网关 → Control Plane `app` + Data Plane FastAPI/`rag`/`public` 投影）**正确且已可私有化试点**。混乱主要集中在**编排与配置层**：Ask / Library policy 在 Python↔JS 双份映射、legacy knobs 与 public profiles 并存、文档对进程/SDK 状态偶有漂移。在 Conditional PASS 前提下，当前阶段是**先收敛、不扩张**：统一事实源与废弃边界，冻结新功能面，再试点稳定后拆大文件与删兼容负担。

### P0 完成度口径

| 已基本收敛（Step 1） | 本轮 / 后置 |
|----------------------|-------------|
| 架构认知（平面 / 双 worker / 事实源表） | **Step 2**：Eval + AskGraph 主线 **已完成** |
| 文档口径（Compose/Helm/outbox、SDK 0.1.0） | 其余模块头批量注释（非必做） |
| 冻结边界声明（§7 + ROADMAP） | 410 实现删除 / codegen（Step 3+） |
| **最小 Py↔JS policy parity**（fixtures + CI） | 消融平台扩张 / OpenAI 层（仍冻结） |
| 四边界模块头（ask_graph / eval runner / lifecycle / process-outbox） | — |
| 试点 Conditional GO @ webch | — |

> **P0（Step 1）= 架构认知 / 文档口径 / 冻结边界 / 最小防漂移门禁已闭环。**
> 剩余 P1（policy/outbox-core 等模块头）非本轮必做；**勿批量加模块头**。

---

## 2. 唯一事实源表

对每个概念：**唯一权威源 → 派生消费者 → 禁止第二定义**。路径均已对照仓库验证。

### 2.1 Ask policy（业务意图）

| 角色 | 路径 / 说明 |
|------|-------------|
| **权威源（产品语义）** | 工作区持久化：`app.workspace_settings.ask`（Drizzle：`apps/web/src/db/schema.ts` → `workspaceSettings`）；读写经 `apps/web/src/lib/server/workspace-settings.ts` + `workspace-ask-settings.mjs` |
| **权威源（公共枚举默认）** | 产品面四键默认：`PUBLIC_ASK_DEFAULTS` — Python：`apps/api/app/services/policy_profiles.py`；JS 镜像：`apps/web/src/lib/server/ask-policy.mjs`（**手工同步** + parity 契约） |
| **权威源（内部 knobs 代码默认）** | `ASK_DEFAULTS`：`apps/api/app/services/ask_defaults.py`（`retrieve_top_k` / hybrid / rerank / adjudicate / session_memory…） |
| **映射（意图 → knobs）** | `resolve_ask_policy`：`policy_profiles.py`；JS：`ask-policy.mjs` 的 `resolveAskPolicy` |
| **请求注入** | Control Plane fail-closed：`ask-overrides-inject.mjs`（BFF `rag-proxy.ts`、Public API `integration-rag.ts`）→ `ask_overrides` + `_ask_policy` |
| **运行时消费** | Data Plane：`ask_overrides.py` → `effective_ask_settings`；`ask_graph.py` / `retrieve.py` / `retrieval.py` |
| **禁止** | 用 `Settings`/env（`HYBRID_ENABLED` 等）作为产品开关；客户端自带 `ask_overrides` 进 HMAC；在第三处再抄一份 profile 表 |

字段权威（产品面）：`answer_profile` · `retrieval_enhancement` · `session_memory_enabled` · `evidence_requirement`。

### 2.2 Library policy

| 角色 | 路径 / 说明 |
|------|-------------|
| **权威源（产品值）** | `app.libraries` / `app.document_versions` 列：`document_profile` · `scan_handling` · `parse_preference`（`apps/web/src/db/schema.ts`） |
| **校验 / API 形状** | Web：`document-policy.mjs` · `library-api.mjs`；路由：`apps/web/src/app/api/libraries/**` |
| **映射（入库执行）** | Python：`resolve_document_policy` / `resolve_parse_plan`（`policy_profiles.py`）；消费：`workers/document_ingest.py` ← `lifecycle_worker` |
| **JS 侧同构映射** | `document-policy.mjs`（与 Python 表**手工同步**；用于预览 / requires_reindex 等） |
| **禁止** | 用户经 API 选 OCR/MinerU Provider；把 deploy-only 旋钮挂到 library/workspace API（见 `document-policy.mjs` 注释） |

### 2.3 Retrieve / Ask v1 合同

| 角色 | 路径 / 说明 |
|------|-------------|
| **权威源** | `docs/contracts/retrieve-ask-v1.md` |
| **实现网关** | Next Public API：`apps/web/src/lib/server/integration-rag.ts` · `public-api-v1-core.mjs`；路由 `/api/v1/retrieve` · `/api/v1/ask` |
| **内部数据面** | FastAPI：`apps/api/app/routers/ask.py` · `retrieve.py`；schema：`apps/api/app/schemas.py` |
| **薄适配** | `sdk/python/` · `sdk/mcp/`（0.1.0，必须 1:1 HTTP，不嵌入引擎） |
| **禁止** | SDK/MCP/未来 OpenAI 层发明第二套字段名或权限语义；客户端传 `ask_overrides` / 算法旋钮 |

### 2.4 Workspace vs Control Plane vs Data Plane 数据语义

| 平面 | 权威事实 | 路径 / Schema | 禁止 |
|------|----------|---------------|------|
| **Workspace（产品 UI）** | 会话、成员、文库 UI、工作区设置；**不**拥有检索真相 | `apps/web` | 绕过 BFF 直连公网 FastAPI |
| **Control Plane** | org/user/workspace、libraries、documents、versions、active pointer、jobs、ACL、outbox、audit | schema **`app`**（Drizzle） | Python 跑 `app` DDL；worker 改身份/ACL |
| **Data Plane** | DocumentIR、切分、embed、Ask 图、检索门禁、turns/threads | FastAPI `apps/api`；schema **`rag`**（Python 迁移，如 active generation） | 浏览器会话、成员邀请、产品路由 |
| **`public`（兼容投影）** | 库/文档投影与历史 turns 等 | SQLAlchemy `apps/api/app/services/metadata.py` 等 | 当作产品 SoT；新功能只写 `public` 不写 `app` |

总览图见 [`ARCHITECTURE.md`](../ARCHITECTURE.md)。

### 2.5 Job / outbox / lifecycle worker

| 概念 | 权威职责 | 入口 | 禁止 |
|------|----------|------|------|
| **Job SoT** | 仅 `app.jobs` | Control Plane 入队；claim：`apps/api/app/lifecycle_worker.py` + `repositories/job_repository.py` | 再引入 ARQ/Redis 作为 ingest 队列；FastAPI 写路径入队 |
| **lifecycle-worker** | `document.ingest` / delete：parse→chunk→embed→staging→激活→延迟清理 | `python -m app.lifecycle_worker`；Compose/Helm `lifecycle-worker` | 处理文库投影 / outbox |
| **outbox-worker** | `app.outbox_events` → HMAC → `/v1/internal/projections/libraries/*` | `apps/web/scripts/process-outbox.mjs`（`pnpm outbox:run`）；Compose/Helm `outbox-worker` | 解析 PDF / 写 Qdrant generation |
| **Redis** | HMAC replay 等 | `settings.redis_url` | Job 事实源 |

### 2.6 文档存储路径与部署必需进程

| 概念 | 权威 | 说明 |
|------|------|------|
| **原文存储** | 生产：`DOCUMENT_STORAGE_ROOT`（web 与 lifecycle-worker **同卷**） | 遗留/测试：`DOCUMENT_STORAGE_DIR` / `document_storage_dir`（`settings.py`）— 非产品 SoT |
| **必需进程（私有 Compose）** | `caddy` · `web` · `api` · `lifecycle-worker` · `outbox-worker` | 已验证：`deploy/compose/docker-compose.yml`；黑盒报告 `0170ba8` |
| **Helm** | api：`api-service.yaml`（ClusterIP）；workers：仅 Deployment（**无** Service） | Chart / Helm README：api 集群内暴露；workers 不创建 Service；三者均不对外 |
| **依赖** | PostgreSQL · Qdrant · Redis · LLM/embedding · 可选 MinerU | 私有包默认不内置数据底座 |

---

## 3. Ask / Policy 当前传播链（已用代码搜索核实）

```text
[代码默认 · 内部 knobs]
  apps/api/app/services/ask_defaults.py          ASK_DEFAULTS / ASK_OVERRIDE_KEYS
        │
        ▼
[意图 → knobs 映射 · Python 权威实现]
  apps/api/app/services/policy_profiles.py       PUBLIC_ASK_DEFAULTS + resolve_ask_policy
        │
        │  ✎ 手工同步（漂移风险 #1）+ 最小 parity 契约
        ▼
[意图 → knobs 映射 · JS 镜像]
  apps/web/src/lib/server/ask-policy.mjs         PUBLIC_ASK_DEFAULTS + resolveAskPolicy
        │
        ▼
[工作区读写 + legacy 数字迁移]
  workspace-ask-settings.mjs  ←  sanitize / migrate_legacy
  workspace-settings.ts       ←  app.workspace_settings
  UI: /app/settings · API: /api/workspace/settings
        │
        ▼
[请求边界 · fail-closed 注入]
  ask-overrides-inject.mjs
    ├─ BFF:     rag-proxy.ts
    └─ Public:  integration-rag.ts
  剥离客户端 ask_overrides → 注入服务端 knobs + _ask_policy
        │
        ▼
[HMAC → Data Plane]
  apps/api/app/services/ask_overrides.py         effective_ask_settings / has_ask_overrides
  apps/api/app/routers/ask.py · retrieve.py
        │
        ▼
[运行时]
  apps/api/app/graph/ask_graph.py                AskGraph（读 effective settings，不读产品 env）
  apps/api/app/services/retrieval.py 等

[旁路 · Settings/env]
  apps/api/app/settings.py                       明确注释：产品 knobs 不在此；
                                                 仅基础设施（DB/Redis/auth/模型 URL 等）
```

### Python ↔ JS 手工同步点（漂移风险）

| # | 同步对 | 风险 |
|---|--------|------|
| 1 | `policy_profiles.py` ↔ `ask-policy.mjs`（`PUBLIC_ASK_DEFAULTS`、profile→knobs、evidence 更严规则） | 改一侧忘改另一侧 → UI 预览与 API 实际不一致 |
| 2 | `ASK_DEFAULTS` ↔ `ask-policy.mjs` 内 balanced 基准注释/常量 | balanced 默认 top_k/min_score 漂移 |
| 3 | `policy_profiles.py` document 映射 ↔ `document-policy.mjs` | 入库行为与 library UI/requires_reindex 不一致 |
| 4 | `ASK_OVERRIDE_KEYS` ↔ web 可注入字段 | 新 knob 只加 Python 或只加 inject |
| 5 | legacy 迁移：`migrate_legacy_ask_to_public`（Py）↔ `workspace-ask-settings.mjs` | 旧工作区 JSON 读出语义分叉 |

**当前不做** codegen / 共享 schema 包（列入 Step 2 之后可选）。

**防漂移（最小闭环）**：共享 fixtures + 双边 runner + 比较脚本，见 [`tests/contracts/policy-parity/`](../../tests/contracts/policy-parity/README.md)。
跑法：`python3 scripts/compare_policy_parity.py`（CI job `policy-parity`）。
Step 1 仍要求：改映射必须双边改；parity 证明**同一输入等值**，单边绿不够。

---

## 4. 兼容路径清单

| 路径 | 状态 | 保留原因 | 建议删除时机 | 禁止 |
|------|------|----------|--------------|------|
| FastAPI ingest 写路径（`/v1/ingest*`、replace/reindex 等）→ **永久 410** | **永久废弃（对外）**；实现仍在仓库以 fail-closed | 防止旧客户端误写；契约明确 | **最早删除版本：正式 GO 后的下一 major**；删除前置：确认无调用日志、契约测试仍覆盖 410、发布迁移说明 | 新调用方；用 env 重新打开 |
| 实现入口 | `apps/api/app/services/ingest/fastapi_ingest_writes.py` · `reject_fastapi_ingest_writes` | — | 同上（路由桩随 major 清理） | 新路由挂旧写逻辑 |
| legacy Ask knobs（数值 top_k/min_score 等经 `ask_overrides` / 旧 settings JSON） | **过渡** | 存量工作区迁移；eval/ablation 仍可能注入 legacy | **最早删除版本：正式 GO 后的下一 major**；删除前置：无 legacy 写入、迁移路径已跑完、parity/契约仍绿 | 新 UI/API 字段；新测试默认用 legacy |
| `ASK_SETTING_DEFAULTS` 别名（web） | **过渡** | 旧 import | **最早删除版本：正式 GO 后的下一 major** | 新代码 import 别名 |
| `public` schema 投影（libraries/documents/turns 等） | **过渡（长期兼容）** | Data Plane 检索/会话仍读投影；outbox 写入 | 完整切到仅 `app`+`rag` 后再删；非本季度 | 新产品事实只落 `public` |
| outbox → `/v1/internal/projections/*` | **现行必需** | 文库变更投影 | 永久保留直至投影模型替换 | 浏览器 BFF 代理 internal 路径 |
| lifecycle-worker vs outbox-worker | **现行双进程** | 职责正交（见 §2.5） | 不合并 | 让一个进程兼做另一职责而不改合同 |
| `DOCUMENT_STORAGE_DIR` / json metadata backend | **过渡 / 测试** | 单测与旧本地路径 | 试点 GO 后收紧文档：生产只提 ROOT | 生产 runbook 主推 DIR |
| 废弃产品 env：`HYBRID_ENABLED` 等 | **永久废弃** | 文档/测试证明「env 不生效」 | 已退出产品面（无删代码压力） | 新功能绑回这些 env |

---

## 5. 文档与部署漂移修复清单（可勾选）

对照 2026-07-27 代码与 Compose/Helm（**`0170ba8` 已含 outbox-worker**；勿再写「Compose 缺 outbox」）。

| 勾选 | 文件 | 现状 | 应改为 |
|------|------|------|--------|
| [x] | `docs/ARCHITECTURE.md` §生产拓扑（约 L55） | 曾漏写 outbox-worker | **已改**：web + rag-api + lifecycle-worker + outbox-worker |
| [x] | `docs/PRODUCT.md`（约 L59） | 曾把 SDK/MCP 列为规划中 | **已改**：SDK/MCP 0.1.0 已交付；Documents/Jobs、OpenAI 仍规划中 |
| [x] | `docs/PRODUCT.md` 成功标准表（约 L149） | 「适配器规划中」 | **已改**：SDK/MCP 已交付；OpenAI 仍规划 |
| [x] | `docs/STRATEGY.md`（约 L139） | 「SDK/MCP…不属于本阶段必交付」 | **已改**：Retrieve/Ask 适配 **0.1.0 已交付**（`sdk/python/` · `sdk/mcp/`）；OpenAI 层仍后置 |
| [x] | `deploy/README.md`（约 L37、L69） | chart 描述 / Helm 句只写 web/api/lifecycle-worker | **已改**：补 **outbox-worker** |
| [x] | `deploy/helm/meriknow/Chart.yaml` | `description: … lifecycle-worker` | **已改**：加上 outbox-worker |
| [x] | `deploy/helm/README.md` | 曾误写 workers「均为 ClusterIP」 | **已改**：api 仅 ClusterIP；lifecycle/outbox **不创建 Service**；三者均不对外 |
| [x] | `docs/acceptance/backup-restore-verification.md`（约 L42） | 停止 app 列表缺 outbox-worker | **已改**：含 **outbox-worker** |
| [x] | `docs/README.md` | 无收敛计划入口 | **已链**到本文 |
| [x] | `docs/runbooks/private-deployment.md` | 已含 outbox-worker | **保持**；勿回退 |
| [x] | `docs/ROADMAP.md` / `docs/INTEGRATION.md` / `docs/contracts/retrieve-ask-v1.md` | SDK/MCP 0.1.0、消融不进 gate 表述基本正确 | 以之为准校对 PRODUCT/STRATEGY；ROADMAP 已加冻结声明 |
| [x] | `docs/runbooks/ask-ablation-eval.md` | 明确「实验，不是发布门禁」 | **保持**；禁止把 ablation 写进 release gate |
| [x] | 任意新报告/README | 若仍写「Compose 缺 outbox」 | 扫描后无残留断言（`0170ba8` 已加） |

**Ablation vs release gate（防再漂移）**

| 工具 | 权威文档 | 角色 |
|------|----------|------|
| `scripts/run_release_gates.py` | `docs/runbooks/quality-release-gates.md` | **发布门禁** |
| `scripts/run_ablation_matrix.py` | `docs/runbooks/ask-ablation-eval.md` | **实验**，变差 ≠ 发布红灯 |

---

## 6. Step 1 执行 backlog（无行为变化）

### 下一步顺序（Step 1 收尾后 → Step 2）

1. ~~修 Helm / 删除时限措辞~~ — **已完成**
2. ~~最小 Py↔JS parity~~ — **已完成**（`tests/contracts/policy-parity/` + CI）
3. ~~四边界模块头~~ — **已完成**（**不要**再批量加头）
4. ~~私有试点稳定性~~ — **Conditional GO @ webch**
5. **当前（Step 2）**：~~先拆 `eval/`（§7.1）~~ **Eval 已完成**；~~AskGraph（§7.2）~~ **AskGraph 主线已完成**；**两模块不同 PR**

### P0 — 文档/废弃标记/冻结声明 / 防漂移起点

- [x] 按 §5 勾选修复文档与部署描述漂移（STRATEGY、deploy/Helm、backup-restore；ARCHITECTURE/PRODUCT/README 已先完成）
- [x] 修正 Helm「均为 ClusterIP」不准确表述（api 有 Service；workers 仅 Deployment）
- [x] 在 `fastapi_ingest_writes.py`、`ask.py`/`libraries.py` 410 路由、`apps/api/README.md` 统一 **DEPRECATION** 口径：对外永久 410；禁止新调用方；**最早删除版本：正式 GO 后的下一 major**；删除前置：确认无调用日志、契约测试仍覆盖 410、发布迁移说明
- [x] 在 `policy_profiles.py` / `ask-policy.mjs` / `document-policy.mjs` 顶部增加「双边同步」警告注释（只注释）
- [x] **最小 Py↔JS policy parity 契约**（`tests/contracts/policy-parity/` + `scripts/compare_policy_parity.py` + CI `policy-parity`）
- [x] 在 `docs/ROADMAP.md` 与本文 §7 增加 **新功能冻结声明**：私有试点 GO 前不扩消融平台、OpenAI 层、新 Ask 分支
- [x] `docs/README.md` 增加本文链接（索引可见）

### P1 — 核心模块顶部 IO / 不变量 / 所有者（只注释，不搬代码）

**优先只做四个边界文件**（其余仍 backlog，勿批量）：

- [x] `apps/api/app/graph/ask_graph.py`
- [x] `apps/api/app/eval/runner.py`
- [x] `apps/api/app/lifecycle_worker.py`
- [x] `apps/web/scripts/process-outbox.mjs`

其余（稳定后再考虑，非本轮必做）：

- [x] `apps/api/app/eval/ablation.py`（标明非 release gate；其余 P1 仍非本轮必做）
- [ ] `apps/api/app/services/policy_profiles.py`
- [ ] `apps/api/app/services/ask_defaults.py` · `ask_overrides.py`
- [ ] `apps/web/src/lib/server/ask-policy.mjs` · `ask-overrides-inject.mjs`
- [ ] `apps/web/scripts/outbox-core.mjs`

### P2 — 生成物 / 临时脚本清单（本任务不批量删除）

| 项 | 审阅结果 / 建议 | 本 Step |
|----|-----------------|---------|
| `__pycache__` / `*.pyc` | 已被 `.gitignore`；本机可清。已清理未跟踪的 `apps/api/scripts/__pycache__` | 仅安全清理；**不入库** |
| `apps/api/scripts/ab_chunk_profiles.py` · `run_ablation_matrix.py` · `ingest_sample.py` 等 | 开发/实验工具；`apps/api/README.md` 已标明样例非产品 HTTP ingest；消融见 runbook | **保留，不删** |
| `apps/api/scripts/NOTES.txt` | **仓库中已不存在**（未跟踪/未提交）；无需再删。勿与 Helm `templates/NOTES.txt` 混淆 | **无操作** |
| `data/` 本地元数据/文档（若存在） | 勿提交；非仓库事实源 | 不进 git |
| 测试临时目录 / `/tmp/meriknow-*` | 本机产物 | 不入库 |

> P2 结论：不批量删脚本；NOTES.txt 已缺席故无归档动作；生成物继续靠 gitignore。

---

## 7. Step 2 打法（已启动）与冻结边界

> **Step 2 进行中**（试点 Conditional GO @ webch）。顺序：**先 Eval（已完成），后 AskGraph**；**两个模块不同 PR**。
> 第一刀**不是按行数搬家**，而是抽依赖边界（Eval：cases/assertions/fixtures/environment/executors；AskGraph：闭包 → `AskGraphContext`）。
> 同步写入 [`docs/ROADMAP.md`](../ROADMAP.md)「明确不做」的仍适用项见 §7.3。

### 7.1 Eval 目标结构与提交顺序 — **已完成**

复用现有 `schemas.py` / `gates.py` / `report.py` / `ablation.py`——**不新建**重复 scorers / reports。

```text
apps/api/app/eval/
  schemas.py          # 保留
  gates.py            # 保留
  report.py           # 保留
  ablation.py         # 保留（实验，非 release gate）
  cases.py            # load_eval_cases / DEFAULT_CASES
  assertions.py       # check_expect / collect_ids
  fixtures.py         # fixture 路径解析 / IR 加载
  environment.py      # isolated settings / ablation resolve
  executors/          # 按 kind 一文件；EXECUTORS 注册表替代大分支
    __init__.py       # EXECUTORS = {kind: fn}
    ask.py · classify.py · ingest_chunk.py · retrieval.py · ingest_http.py
  runner.py           # ~100 行：调度 + 过渡期 re-export；旧 import 仍可用
  cli.py              # main / argparse（可后置从 runner 抽出）
```

| 提交 | 内容 | 状态 |
|------|------|------|
| E1 | characterization tests（runner 调度、主要 executor、断言路径）绿 | 已完成 |
| E2 | `cases` / `assertions` / `fixtures` / `environment` 抽出；runner re-export | 已完成 |
| E3 | `executors/` + `EXECUTORS` 注册表；迁出 ask/classify/ingest/retrieval | 已完成 |
| E4 | runner 收薄；未知 kind **fail-closed**；可选 `cli.py` | 已完成（cli 可后置） |

**完成标准（Eval）** — **已满足**

- `run_eval_cases` 经 `EXECUTORS` 调度，无大 `if/elif` 分支
- 未知 / 非法 executor kind **fail-closed**（显式 `ValueError`，不静默回落 ask）
- 断言语义、消融行为、gate 条件**不变**
- 不新建与 `report.py` / `gates.py` 重复的 scorers/reports
- 旧 `from app.eval.runner import …` 过渡期可用
- 每提交 eval 相关 pytest + release gate 子集绿

### 7.2 AskGraph 目标结构与提交顺序 — **主线已完成**

> Eval 拆分已合入；AskGraph 为**独立 PR**。提交 1–7 已完成 → **AskGraph Step 2 主线完成**（可选：迁入 `graph/ask/` 包、facade 删除、同步/流式更深去重 — 非本轮必做）。

**第一刀不是按行数搬家**：把节点依赖从闭包取出 → **`AskGraphContext`**（已解析的 `EffectiveAskSettings`、注入的 store/LLM/retriever 等）。节点只收 `State + Context`；**禁止**节点再 `resolve` policy / 读 env / 碰 DB singleton。

```text
apps/api/app/graph/          # 提交 2–7 平铺 + nodes/ + service；后续可迁入 ask/
  state.py                   # AskState / RetrieveFn / GenerateFn / LoadTableGroupsFn
  messages.py                # history / rewrite / generate 消息拼装
  stubs.py                   # stub retrieve / generate / table store
  persistence.py             # turns 持久化（persist_turn 等）
  lifecycle.py               # 请求准备 / 历史读取 / temp session memory
  context.py                 # AskGraphContext（含已解析 EffectiveAskSettings）
  nodes/                     # 提交 5：按亲和分组的节点工厂
    routing.py               # query_router / build_plan / clarify + route helpers
    rewrite.py               # 多轮改写 + structured plan request
    retrieval.py             # 普通检索
    table.py                 # 表格检索与执行
    decision.py              # judge / retry / refuse
    generation.py            # 生成与引用对账
  topology.py                # 提交 6：纯图连线；无算法（`compile_ask_topology`）
  builder.py                 # `build_ask_graph` 组装（真实实现；facade re-export）
  service.py                 # 提交 7：prepare_request → execute/stream → finalize
  ask_graph.py               # facade（re-export）+ 兼容入口
apps/api/app/graph/ask/      # 可选迁入（正式 GO 前非必做）
  context.py                 # 可自 graph/context 迁入
  topology.py                # 可自 graph/topology 迁入
  service.py                 # 可自 graph/service 迁入
  nodes/                     # 可自 graph/nodes 迁入
```

| 提交 | 内容 | 状态 |
|------|------|------|
| 1 | characterization tests（同步 ask / 流式 / refuse / stub 路径） | ✅ |
| 2 | `state` / `messages` / `stubs` 抽出（`ask_graph` re-export；无行为变化） | ✅ |
| 3 | `persistence` / `lifecycle` | ✅ |
| 4 | **Context 替换闭包**（节点经 `AskGraphContext`；policy 只在入口解析一次） | ✅ |
| 5 | 按 routing/rewrite/retrieval/table/decision/generation **分组搬节点** | ✅ |
| 6 | `topology`（无算法） | ✅ |
| 7 | `service`：`prepare_request` → `execute`/`stream` → `finalize`；同步与流式共享收尾 | ✅ |

**Service 边界**：入口一次解析 policy → 写入 Context；节点不读 env/DB/singleton；同步与流式共享 `finalize_result`（流式 finish 钩子 `append_memory=False`，保持历史顺序）。

**完成标准（AskGraph）** — **已满足**

- topology **无算法**
- node **不读** env / DB / singleton；**不**再 resolve policy
- Context 携带**已解析** `EffectiveAskSettings`
- policy **只在入口解析一次**
- 同步 / 流式共享收尾（`prepare_request` + `finalize_result`；流式 token 路径仍独立）
- 旧 `ask_graph` import 过渡期可用；每提交 release gate 绿
- facade 删除时机 = **正式 GO 后的下一 major**（与 §4 一致）

**AskGraph 当前进度**：提交 1–7 **已完成** → **AskGraph Step 2 主线完成**。可选后续：`graph/ask/` 包迁入、facade 删除、同步/流式更深去重（非必做）。

**收尾（可选）**：`nodes.rewrite` → `ask_graph` 的反向依赖（为兼容 monkeypatch 的 late-bind）**已消除**；`_request_structured_retrieval_plan_json` 在 `nodes/rewrite.py` 本地调用，`ask_graph` 仅 facade re-export。  
`service.py` → `ask_graph` facade 的 reverse late-import **已消除**（2026-07-28）：`build_ask_graph` 在 `builder.py`；`persist_turn` / `single_document_version_id` 直调 `persistence`；测试 patch 指向真实模块 / `service` 绑定；`ask_graph` 仍 re-export。另补 live `stream_messages` 中途异常 characterization。

**告警（私有）**：webch 告警通道先接 **Resend 邮件**（`ops/min_alerts`，非飞书）；飞书 webhook 可后置。**Step 3（B：删 410 / legacy knobs / schema codegen）尚未开始**。

### 7.3 现在不做（Step 2 期间仍冻结）

| 不做 | 说明 |
|------|------|
| **不删** 410 后内部实现 / 路由桩 | Step 3（正式 GO 后的下一 major；见 §4 删除前置） |
| **不统一** Py/TS schema codegen / 共享 schema 包 | Step 1 最小 parity 已够；不做共享包 |
| **不合并** lifecycle 与 outbox 进程 | 职责已分清 |
| **不扩张** 消融为平台产品 / 把 ablation 纳入 CI release gate | **冻结** |
| **不实现** OpenAI-compatible 层加深 | **冻结** |
| **不新增** Ask 图分支 / 平行 policy 引擎 | **冻结** |
| **不按行数** 无边界搬家 | 先 Context / EXECUTORS，再分组搬 |
| **不在 characterization 轮拆** `ask_graph.py` 实现 | 仅加测试（最多极小可测性改动）；结构抽取从提交 2 起 |

三步顺序回顾：

1. ~~事实源、废弃标记、文档漂移、最小 parity、边界模块头、功能冻结~~ — **Step 1 已完成**
2. **进行中**：~~Eval 拆分~~ **已完成**；~~AskGraph 提交 1–7~~ **主线已完成**（可选包迁入 / facade 删除后置）
3. 删兼容负担（410 内部残骸、legacy knobs、过时别名、facade）— 正式 GO 后的下一 major

---

## 8. 成功标准

### 8.1 Step 1 验收（已满足，2026-07-27）

1. **单一入口**：新人从 `docs/README.md` → 本文即可找到各概念权威源与禁止项。
2. **部署一致**：`ARCHITECTURE` / `private-deployment` / Compose / Helm 文案均列出 **outbox-worker**；Helm 正确区分 api Service vs workers 无 Service；无「Compose 缺 outbox」旧断言。
3. **适配器状态一致**：PRODUCT / STRATEGY / ROADMAP / INTEGRATION 对 Python SDK·MCP **0.1.0 已交付** 口径一致。
4. **废弃有时限**：§4 每条有状态 + 删除时机；代码/README 统一为：**最早删除版本：正式 GO 后的下一 major**；删除前置：确认无调用日志、契约测试仍覆盖 410、发布迁移说明。
5. **消融非门禁**：文档与 CI 不把 ablation 当作 release gate。
6. **无行为变化**：不改 Python/TS 业务逻辑（parity 仅测既有映射）；既有 pytest / web 单测 / CI gate 仍绿。
7. **冻结可执行**：§7.3 清单被 ROADMAP 或本文引用，PR 审查可拒绝越界改动。
8. **防漂移起步**：`python3 scripts/compare_policy_parity.py`（或 CI `policy-parity`）对共享 fixtures **Py↔JS 等值**通过。

**验收判定（2026-07-27）**：上列 1–8 已满足 → **Step 1 完成**。试点 Conditional GO @ webch 后进入 Step 2。

### 8.2 Step 2 验收（进行中）

1. ~~Eval：目标结构落地；`EXECUTORS` 调度；断言/消融/gate 语义不变；旧 import 可用。~~ **已完成**（含未知 kind fail-closed）。
2. ~~AskGraph：Context 替换闭包；topology 无算法；节点只收 State+Context；policy 入口一次解析；同步/流式共享 finalize。~~ **已完成**（提交 1–7；characterization 为提交 1）
3. 两模块分 PR；每提交相关 release gate 绿；无行为变化。

---

## 附录：关键路径速查

| 主题 | 路径 |
|------|------|
| Ask 图 | `apps/api/app/graph/ask_graph.py` facade · `builder.py` · `service.py` · `topology.py` · `nodes/`（见 §7.2） |
| Eval | `apps/api/app/eval/`（`runner` facade · `executors/` · `cases`/`assertions`/`fixtures`/`environment` · `ablation`） |
| Policy | `apps/api/app/services/policy_profiles.py` · `ask_defaults.py` · `ask-policy.mjs` |
| Policy parity | `tests/contracts/policy-parity/` · `scripts/compare_policy_parity.py` |
| Compose outbox | `deploy/compose/docker-compose.yml` → service `outbox-worker` |
| Helm outbox | `deploy/helm/meriknow/templates/outbox-worker-deployment.yaml` |
| Helm api Service | `deploy/helm/meriknow/templates/api-service.yaml`（workers 无对应 Service） |
| v1 合同 | `docs/contracts/retrieve-ask-v1.md` |
| 私有黑盒 | `docs/acceptance/reports/2026-07-27-private-0170ba8-blackbox.md` |
