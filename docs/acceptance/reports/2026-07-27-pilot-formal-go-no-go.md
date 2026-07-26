# 试点正式验收 / 签字结论稿（RC2-X 证据基线）

> **状态：待审批人签字** — 技术侧证据已齐，**可进入签字流程**；本文**未**宣称已正式 GO。  
> 勾选与签字栏须由审批人确认后生效；仓库提交本文件不等于完成签字。

## 元数据

| 字段 | 值 |
|---|---|
| **批准发布候选 SHA（唯一审批对象）** | `b72a585d1d6a1e0406c9420ae3d1f5edbce67fbe` |
| 证据基线标签 | **RC2-X**（分项运行时）+ 发布候选 **`b72a585`**（含 B5 实现与签字稿） |
| 产品验收运行时基线（B2/R3） | `a79d2a53c5ecb32423dae179bdb05784af187a46` |
| 拓扑 | 本机混合栈 + B2/B3 独立 Compose 演练环境 |
| 日期 | 2026-07-27 |
| 模板 | [`../pilot-go-no-go-template.md`](../pilot-go-no-go-template.md) |

> 审批签字时请写明：**批准发布版本 = `b72a585`**（或在其上打的 tag）。分项证据 SHA 仅作附件溯源，不替代唯一发布对象。

## Commit 绑定（以 `git log` 核实）

| 里程碑 | 短 SHA | 完整 SHA | 说明 |
|---|---|---|---|
| S1/S2 / Pilot RC1 | `b98f014` | `b98f01438045c92804204449d3172ceb201490e6` | 隔离脚本与 structured-retrieval RC |
| RC2-X 运行时基线 | `a79d2a5` | `a79d2a53c5ecb32423dae179bdb05784af187a46` | B2/R3 干净树复跑绑定 |
| RC2-X 报告闭合 | `b8223aa` | `b8223aa9388c5a24f8079602d57da24340f9360c` | B2/R 报告（运行时仍绑 RC2-X） |
| B3/B4 脚本 + 演练 | `88b72d9` | `88b72d9daf7910c4eed9d51963d9e4e9ac7feb8c` | 升级/回滚脚本与实测 |
| B3/B4 报告 | `2e27c1c` | `2e27c1c782b22ebc3693dd77d557887e2017a7f1` | 记录 B3/B4 PASS |
| B5 实现接线 | `4a249d2` | `4a249d258ee9ab8576bb22f2755444bd14d7fad6` | min-alerts webhook |
| B5 PASS 证据（初跑） | `9b80fe3` | `9b80fe388ddc4f83863c5beaa4395577dea43158` | 报告 + payload 修正（初跑 porcelain 非空） |
| B5 证据戳记 | `c4c0f6c` | `c4c0f6ce4a2386eb8e4f5cc2b683233337480f7a` | 报告内 SHA 戳记 |
| 签字稿初版 | `b72a585` | `b72a585d1d6a1e0406c9420ae3d1f5edbce67fbe` | **发布候选**；其干净树上复跑 B5 |

### 在发布候选 `b72a585` 上的最终总门禁（非破坏性）

| 门禁 | 结果 | 备注 |
|---|---|---|
| 工作树 | **干净** | `git status --porcelain` 为空 |
| B5 干净复跑 | **PASS** | `rc_sha=git_head=script_sha=b72a585…`；`porcelain=""`；sha256 `e8b3c7eddebe17a2c9601199c2da89f0f6a82d9efcb5b6ecaf0723e19b5163c0` |
| `pilot-preflight.sh` | **PASS** | isolation + CI gate 36/36 |
| API 契约/健康相关 pytest | **PASS** | 52 passed |
| `apps/web` `pnpm build` | **PASS** | production build |
| `pilot-smoke.sh` | **SKIP** | 本地 `MERIKNOW_ADMIN_PASSWORD` 仍为 placeholder，脚本按设计 exit 2；**不**计为 FAIL |

---

## RC2-X / 当前证据基线

```
RC2-X / 当前证据基线
├── S1/S2 PASS
├── B2 PASS
├── R1–R4 PASS
├── B3 PASS
├── B4 PASS
├── B5 PASS（S5：真实 df + force 注入；非真实灌盘）
├── 已知限制
└── 审批人签字栏（待签）
```

### S1 / S2 — PASS

| 项 | 结果 | 报告 |
|---|---|---|
| S1 跨 organization 零泄漏 | **PASS** | [`2026-07-26-pilot-rc-s1-s2.md`](./2026-07-26-pilot-rc-s1-s2.md) |
| S2 跨 workspace 零泄漏 | **PASS** | 同上 |

绑定：`b98f014`（脚本 `s1_s2_isolation.sh` exit 0）。

### B2 — PASS

| 项 | 结果 | 报告 |
|---|---|---|
| 独立环境 backup → destroy → restore；Qdrant↔PG exact match | **PASS** | [`2026-07-26-pilot-rc-b2-r-fault.md`](./2026-07-26-pilot-rc-b2-r-fault.md) |

绑定：**RC2-X** `a79d2a5`（干净工作树复跑）。备份完成延迟 5s / 丢失 0 / RTO 22s；目标 RPO 未定义。

### R1–R4 — PASS

| ID | 结果 | 摘要 |
|---|---|---|
| R1 | **PASS** | SIGTERM drain 后可恢复 claim |
| R2 | **PASS**（未在 RC2-X 重跑） | Qdrant stop → health degraded / Ask 503 |
| R3 | **PASS** | 模型不可用 → HTTP 503 + 明确错误 + trace；索引未破坏 |
| R4 | **PASS** | MinerU unreachable → job failed 可定位 |

报告：[`2026-07-26-pilot-rc-b2-r-fault.md`](./2026-07-26-pilot-rc-b2-r-fault.md)。  
绑定：R3 干净树复跑 = RC2-X `a79d2a5`。

### B3 — PASS

| 项 | 结果 | 报告 |
|---|---|---|
| 旧版 seed → 备份 → migrate → 新版冒烟 + 一致性 | **PASS** | [`2026-07-27-pilot-rc-b3-b4.md`](./2026-07-27-pilot-rc-b3-b4.md) |

绑定：证据提交 `88b72d9`；报告 `2e27c1c`；运行时基线可追溯 RC2-X `a79d2a5`。

### B4 — PASS

| 项 | 结果 | 报告 |
|---|---|---|
| B4A 仅应用回滚 | **PASS** | [`2026-07-27-pilot-rc-b3-b4.md`](./2026-07-27-pilot-rc-b3-b4.md) |
| B4B 升级前备份恢复（B2 语义） | **PASS** | 同上 |

绑定：同 B3（`88b72d9` / `2e27c1c`）。

### B5 — PASS（含已知限制）

| 信号 | 结果 |
|---|---|
| S1 health.qdrant_ask / S2 worker.heartbeat / S3 jobs.dead_stuck / S4 ask.http_5xx / S5 disk.usage | **PASS**（firing→webhook→resolved） |

报告：[`2026-07-27-pilot-rc-b5-min-alerts.md`](./2026-07-27-pilot-rc-b5-min-alerts.md)。  

| 绑定 | 值 |
|---|---|
| 实现接线 | `4a249d2`（含 `lifecycle_worker.py` ready-file 心跳） |
| 初跑证据 | `9b80fe3`（当时 `porcelain= M ops/min_alerts/check.py`，**非**干净树） |
| **干净复跑（发布候选）** | **`b72a585`**：五项 PASS；sha256 `e8b3c7ed…`；`porcelain=""` |

**S5 / 运维已知限制（签字前须确认）：**

1. 本机未对 documents/PG/Qdrant 卷做 **真实灌盘** 至 >85%（避免 destructive）。  
2. 验收同时覆盖：**真实 df 测量**（干净复跑约 57.87%，未误报）+ `MERIKNOW_ALERT_DISK_FORCE_PERCENT` **force 注入** webhook 路径。  
3. Webhook 为通用 JSON 接收端（`check.py once|watch` + mock）；**无** Compose/systemd/Kubernetes 常驻部署清单——须配置真实常驻方式与接收端，或审批人书面接受该运维风险。

---

## 已知限制（汇总）

| # | 限制 | 影响 |
|---|---|---|
| 1 | B5 S5 为真实 df + force 注入，**非**真实灌盘 | 磁盘告警路径已通；极端写满场景未 destructive 验证 |
| 2 | Webhook 落点未绑定具体生产通道；无常驻部署清单 | 须运维确认 `watch`/cron/systemd + 接收端与 on-call，或书面接受风险 |
| 3 | R2 未在 RC2-X 干净树重跑（历史 PASS） | 可接受为已知；若审批人要求可复跑 |
| 4 | `pilot-smoke.sh` 因本地 admin 密码仍为 placeholder 而 SKIP | 总门禁不记 FAIL；部署前须换成真实密码并重跑 smoke |
| 5 | 完整 Grafana / OIDC / SDK / MCP / 成本面板 | 非本轮范围（既有产品边界） |
| 6 | 目标 RPO 未定义 | B2 仅测单次备份窗口，不承诺周期 RPO |
| 7 | Web 无正式旧镜像标签（B3 用 `meriknow-web:local`） | 已在 B3/B4 报告写明 |

---

## 技术侧汇总（非签字）

| 维度 | 状态 |
|---|---|
| S1/S2、B2、R1–R4、B3、B4、B5 | 五项主线验收报告均为 **PASS** |
| 技术结论 | **证据齐全，可进入签字** |
| 正式 GO | **未宣称** — 须审批人在下方勾选并签字 |

**建议勾选（默认，供审批人参考）：**

- [x] **Conditional GO** — 技术证据齐全，待审批人确认正式 GO；签字前须确认 B5 webhook 落点与 S5 磁盘证明方式（force 注入 vs 真实灌盘）。  
- [ ] **GO** — 仅当审批人书面接受上述限制并完成签字后勾选（**当前勿由技术侧代勾**）。  
- [ ] **NO-GO**

> 若审批人五项验收齐且书面接受 B5 限制：可考虑将勾选改为 **正式 GO**；在此之前保持 **Conditional GO / 待签字**。

---

## 审批人签字栏

| 字段 | 填写 |
|---|---|
| **批准发布 SHA** | `b72a585d1d6a1e0406c9420ae3d1f5edbce67fbe`（或等价 tag：________） |
| 结论（勾选恰好一项） | [ ] GO [ ] Conditional GO [ ] NO-GO |
| 审批人姓名 | ________________ |
| 日期 | ________________ |
| 一句话理由 | ________________ |
| 签字确认 | ________________ |

**Conditional GO 未决项（若勾选 Conditional GO）：**

| # | 未决项 | 关闭条件 |
|---|---|---|
| 1 | B5 webhook 生产落点 + 常驻运行方式 | 书面确认接收通道、值班响应，以及 `watch`/cron/systemd/K8s 之一 |
| 2 | S5 磁盘证明方式 | 书面接受「force 注入」或另开真实灌盘窗口 |
| 3 | （可选）`pilot-smoke` 在真实 admin 密码下重跑 | 部署环境凭据就绪后执行 |
| 4 | （可选）R2 在发布 SHA 复跑 | 审批人要求时再跑 |

---

## 附件索引

| 附件 | 路径 |
|---|---|
| S1/S2 | [`2026-07-26-pilot-rc-s1-s2.md`](./2026-07-26-pilot-rc-s1-s2.md) |
| B2 + R1–R4 | [`2026-07-26-pilot-rc-b2-r-fault.md`](./2026-07-26-pilot-rc-b2-r-fault.md) |
| B3/B4 | [`2026-07-27-pilot-rc-b3-b4.md`](./2026-07-27-pilot-rc-b3-b4.md) |
| B5 | [`2026-07-27-pilot-rc-b5-min-alerts.md`](./2026-07-27-pilot-rc-b5-min-alerts.md) |
| 观测草稿 | [`../observability-min-runbook.md`](../observability-min-runbook.md) |
| go/no-go 模板 | [`../pilot-go-no-go-template.md`](../pilot-go-no-go-template.md) |
