# CI/CD P0 闭环

> 状态：**进行中**（2026-07-28）。CI、ACR + GHCR 双 Registry 发布 workflow、digest manifest、pull 升级脚本和真实告警已落地；仍待 ACR Secret、首次真推和人工批准 SSH CD。
>
> 路线（已确认）：**停止结构清理 → CI 构建/扫描/推镜像 → 人工批准 CD → 真实告警与恢复演练 → 正式 GO → 下一 major 再硬删。**

---

## 1. 目标形态

```text
构建一次 → 测试扫描 → 推 Registry → digest 分发 → 人工批准 → SSH 部署
```

| Workflow | P0 本轮 |
|----------|---------|
| `.github/workflows/ci.yml` | **已做** — PR + `main`；pytest / web / release gate / parity / Docker 构建验证（不推） |
| `.github/workflows/eval-gates.yml` | **保留** — 改为 `workflow_call`（+ 手动），由 `ci.yml` 调用 |
| `.github/workflows/release-images.yml` | **已做** — 三 target 各构建一次，同时推 ACR + GHCR；Trivy `HIGH/CRITICAL` 门禁通过后产出区域 digest manifest |
| `promote-images.yml` | **未建** — 后置 |
| `deploy.yml` | **未建** — 改完 `upgrade.sh` 且有 Environment 批准后再做 |

权限约定：`ci.yml` 仅 `contents: read`；`release-images.yml` 额外使用 `packages: write` 推 GHCR。均不用 `pull_request_target`，不读取 SSH 或生产应用 Secret。

---

## 2. P0 Checklist

### 2.1 本轮（代码闭环）

- [x] `deploy/compose/scripts/upgrade.sh`：默认 `compose pull`；更新 **outbox-worker**；拒绝 `latest`/空 tag；保留旧 pin 可应用回切；迁移失败不自动回滚 DB；health 后跑 `pilot-smoke.sh`（若存在）
- [x] `.github/workflows/ci.yml` 入口
- [x] `eval-gates.yml` 可复用、不丢 L7 / policy parity
- [x] `release-images.yml`：单次构建双推 ACR + GHCR，Trivy 扫描三张镜像，通过后输出 `release-acr.env` / `release-ghcr.env`
- [x] 品牌残留门禁：受版本控制的内容和路径不得重新出现旧品牌
- [x] 文档：冻结 Step 3 硬删；正式 GO 含发布闭环；本文

### 2.2 下一轮（真发布路径）

- [ ] 配置 ACR GitHub Secrets（`ACR_REGISTRY` / `ACR_USERNAME` / `ACR_PASSWORD` / `ACR_NAMESPACE`）
- [ ] 手动运行 `release-images`（`dry_run=false`），验证双 Registry digest 与 artifact
- [ ] `deploy.yml` + GitHub Environment 人工批准 + SSH（仍不把密钥写入仓库）
- [x] webch：Resend firing / resolved 演练通过
- [ ] 正式 GO 签字（见收敛计划 § 正式 GO 门禁）

### 2.3 明确不做（本阶段）

- Step 3 硬删（410 / legacy knobs / `ask_graph` facade / schema codegen）
- TCR/Harbor、Cosign/OIDC、Dokploy
- 在仓库中存放生产 Secret / SSH 私钥

---

## 3. `upgrade.sh` 行为变更

**旧**：`mk_compose build` → migrate → drain lifecycle → roll api/web/lifecycle（**漏 outbox-worker**）。

**新**（默认）：

```bash
cd deploy/compose
./scripts/backup.sh ./backups/pre-upgrade   # 强烈建议
./scripts/upgrade.sh --manifest /path/to/release.env
# 或
./scripts/upgrade.sh --web IMG --api IMG --migrator IMG
# 或（已 pin 且非 latest）
./scripts/upgrade.sh --from-runtime
```

要点：

1. **必须**给出明确 release（manifest / 三镜像 / `--from-runtime`）；拒绝空 tag 与 `latest`。
2. 默认 **`docker compose pull`**；仅 `--allow-build` 为 break-glass 本地构建。
3. 写入 `runtime.env` 前保存旧 pin 到 `deploy/compose/.upgrade-state/previous-images.env`。
4. **additive migration**：migrate 失败 → **不**自动 down-migrate / restore DB；恢复旧镜像 pin 并退出，数据问题走 `backup.sh` / `restore.sh`。
5. 滚动顺序：drain `lifecycle-worker` → `api` → `web` → `lifecycle-worker` → **`outbox-worker`** → `caddy`。
6. Health 失败或 `pilot-smoke` FAIL → **应用回滚** = 重新部署旧 digest/tag；smoke exit 2（SKIP）不触发回滚。

---

## 4. 与 Step 3 / 正式 GO

- **停止**把工程带宽花在结构硬删上；硬删仍受「正式 GO 后的下一 major」约束（见 `docs/architecture/convergence-plan.md`）。
- **正式 GO 门禁**除试点黑盒 / 告警 / 恢复外，须含 **发布闭环**：CI 绿 →（后续）digest 推送 → 人工批准 → `upgrade.sh` pull 部署可重复。

密钥与凭据只存在于部署机 / GitHub Secrets / 客户 Secret 存储，**永不**提交进 git。
