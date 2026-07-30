# CI/CD 发布闭环

> 状态：**部分可用**（2026-07-29）。CI、ACR + GHCR 双 Registry 发布 workflow、
> 五镜像 Trivy 门禁、digest manifest、pull 升级脚本和真实告警已落地；仍待目标
> Registry 的首次真推与人工批准 CD。
>
> **GitHub Actions 暂不可用时：** 用本机 **Just** 发布（见 §5），不依赖托管
> runner。两条路径共用同一套镜像命名与 `upgrade.sh --manifest`。
>
## 1. 目标形态

```text
构建一次 → 测试扫描 → 推 Registry → digest 分发 → 人工批准 → SSH 部署
```

| Workflow | 当前状态 |
|----------|---------|
| `.github/workflows/ci.yml` | **已做** — PR + `main`；pytest / web / release gate / parity / Docker 构建验证（不推） |
| `.github/workflows/eval-gates.yml` | **保留** — 改为 `workflow_call`（+ 手动），由 `ci.yml` 调用 |
| `.github/workflows/release-images.yml` | **已做** — web / api / migrator / outbox / DBOS worker 五个 target 各构建一次，同时推 ACR + GHCR；Trivy `HIGH/CRITICAL` 门禁通过后产出区域 digest manifest |
| `promote-images.yml` | **未建** — 后置 |
| `deploy.yml` | **未建** — 改完 `upgrade.sh` 且有 Environment 批准后再做 |

权限约定：`ci.yml` 仅 `contents: read`；`release-images.yml` 额外使用 `packages: write` 推 GHCR。均不用 `pull_request_target`，不读取 SSH 或生产应用 Secret。

---

## 2. 发布 Checklist

### 2.1 本轮（代码闭环）

- [x] `deploy/compose/scripts/upgrade.sh`：默认 `compose pull`；更新 **outbox-worker**；拒绝 `latest`/空 tag；保留旧 pin 可应用回切；迁移失败不自动回滚 DB；health 后跑 `pilot-smoke.sh`（若存在）
- [x] `.github/workflows/ci.yml` 入口
- [x] `eval-gates.yml` 可复用，保留 deterministic gate / policy parity
- [x] `release-images.yml`：单次构建双推 ACR + GHCR，Trivy 扫描五张镜像，通过后输出 `release-acr.env` / `release-ghcr.env`
- [x] 品牌残留门禁：受版本控制的内容和路径不得重新出现旧品牌
- [x] 发布文档与升级脚本使用同一五镜像 manifest 契约

### 2.2 下一轮（真发布路径）

- [x] 本机发布旁路：根目录 `justfile` + `scripts/release/local-images.sh`（账单锁定时可用）
- [ ] 配置 ACR GitHub Secrets（`ACR_REGISTRY` / `ACR_USERNAME` / `ACR_PASSWORD` / `ACR_NAMESPACE`）
- [ ] 手动运行 `release-images`（`dry_run=false`），验证双 Registry digest 与 artifact（或用 `just release` 等价真推）
- [ ] `deploy.yml` + GitHub Environment 人工批准 + SSH（仍不把密钥写入仓库）
- [x] 最低告警实现与 firing / resolved 自动化验收
- [ ] 目标交付环境的真实告警接收方完成 firing / resolved 演练
- [ ] 正式 GO 签字（见 [`docs/acceptance/`](../acceptance/README.md)）

### 2.3 明确不做（本阶段）

- 在明确废弃窗口前删除 410 兼容入口或旧契约标记
- TCR/Harbor、Cosign keyless/OIDC 签名、Dokploy
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
./scripts/upgrade.sh --web IMG --api IMG --migrator IMG --outbox IMG --worker IMG
# 或（已 pin 且非 latest）
./scripts/upgrade.sh --from-runtime
```

要点：

1. **必须**给出明确 release（manifest / 五镜像 / `--from-runtime`）；拒绝空 tag 与 `latest`。当前 manifest 同时锁定 `UNORAG_DBOS_APPLICATION_VERSION`；旧 manifest 仅兼容未启用 DBOS profile 的部署。
2. 默认 **`docker compose pull`**；仅 `--allow-build` 为 break-glass 本地构建。
3. 写入 `runtime.env` 前保存旧 pin 到 `deploy/compose/.upgrade-state/previous-images.env`。
4. **additive migration**：migrate 失败 → **不**自动 down-migrate / restore DB；恢复旧镜像 pin 并退出，数据问题走 `backup.sh` / `restore.sh`。
5. 滚动顺序：drain `lifecycle-worker` → `api` → `web` → `lifecycle-worker` → **`outbox-worker`** → `caddy`。
6. Health 失败或 `pilot-smoke` FAIL → **应用回滚** = 重新部署旧 digest/tag；smoke exit 2（SKIP）不触发回滚。

---

## 4. 与正式 GO

- 兼容入口的删除按
  [PRODUCT.md](../PRODUCT.md) 与公开契约中的 deprecation 条件执行。
- **正式 GO 门禁**除试点黑盒 / 告警 / 恢复外，须含 **发布闭环**：CI 绿 →（后续）digest 推送 → 人工批准 → `upgrade.sh` pull 部署可重复。

密钥与凭据只存在于部署机 / GitHub Secrets / 客户 Secret 存储，**永不**提交进 git。

---

## 5. 本机 Just 发布（Actions 不可用时）

前置：`brew install just`、本机 Docker、已 `docker login` 目标 Registry。

```bash
just --list

# 只构建（默认 linux/amd64，适合从 Apple Silicon 打服务器镜像）
just images v0.0.1

# 门禁（可跳过）+ 构建 + 推送 + 写 digest manifest
JUST_SKIP_CHECK=1 just release v0.0.1 registry.cn-hangzhou.aliyuncs.com/你的命名空间

# 部署机
./deploy/compose/scripts/backup.sh ./backups/pre-upgrade
./deploy/compose/scripts/upgrade.sh --manifest dist/release/release-registry.env
```

| 产物 | 说明 |
|------|------|
| `dist/release/release-local.env` | 仅本地 `name:tag`（不上服务器） |
| `dist/release/release-registry.env` | 五个 digest 镜像键 + DBOS workflow 兼容版本，喂给 `upgrade.sh` |
| `dist/release/release-manifest.json` | tag / git sha / digest 记录 |

镜像命名与 `release-images.yml` 对齐：
`{registry}/unorag:web|api|migrator|outbox|worker-{tag}`。拒绝 `latest`。
`dist/` 已在 `.gitignore`。
