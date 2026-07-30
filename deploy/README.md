# UnoRAG 私有化部署包

本目录是客户可安装的私有部署参考包。首片以 **Docker Compose 单机拓扑** 为主；
**Helm/K8s 起步骨架** 已提供；镜像 CVE 扫描已进入发布门禁，SBOM 与签名后置。

产品定位与开工 checklist：[`docs/PRODUCT.md`](../docs/PRODUCT.md) ·
[`docs/ROADMAP.md`](../docs/ROADMAP.md)。
试点 go/no-go 见 [`docs/acceptance/`](../docs/acceptance/README.md)。

## 目录

```text
deploy/
  README.md                 # 本文件
  config/
    runtime.env.example     # 非敏感运行期配置 → runtime.env
    runtime.secret.example  # Secret 名称模板 → runtime.secret
    bootstrap.env.example   # 一次性 bootstrap → bootstrap.env
  compose/
    docker-compose.yml      # 单机参考拓扑（按服务最小权限注入）
    env.example             # 指向 deploy/config 的简短说明（勿再填大而全 .env）
    Caddyfile               # 反向代理：仅暴露控制面
    scripts/
      init-config.sh        # 复制 example → 真实文件（不覆盖）
      compose-env.sh        # mk_compose / --env-file 助手
      install.sh            # 安装：infra → migrate → app
      upgrade.sh            # 滚动升级：compose pull + drain + outbox；见 docs/ops/cicd.md
      backup.sh             # 维护窗口：PostgreSQL / DBOS / 对象 / Qdrant 冷备
      restore.sh            # 恢复（需显式确认）
      pilot-preflight.sh    # 隔离单测 + CI gate（可无 Compose）
      pilot-smoke.sh        # upload→ask→replace→delete 冒烟
  docker/
    api.Dockerfile
    web.Dockerfile
  helm/
    README.md               # Helm 安装说明
    unorag/               # chart：web / api / workers；DBOS migration cohort 可选
```

## 快速开始

完整步骤与验收见 [`docs/runbooks/private-deployment.md`](../docs/runbooks/private-deployment.md)。

```bash
cd deploy/compose
./scripts/init-config.sh
# 编辑 ../config/runtime.env、runtime.secret、bootstrap.env

./scripts/install.sh
# 浏览器：http://localhost/
# 健康：curl -sf http://localhost/api/rag/health
```

根目录 `docker-compose.yml` 仍只提供本机联调基础设施（Postgres/Qdrant/Redis）。
客户式全栈安装请使用 `deploy/compose/`。

## 本片已覆盖

- Compose 参考拓扑（Caddy → web；api / lifecycle-worker / outbox-worker 仅内网；DBOS cohort 可选）
- 客户托管连接与模型 endpoint（全部经环境变量）
- secret 仅从环境注入；镜像不含密钥
- production fail-closed 与 readiness 说明
- migration 独立步骤（migrator 凭据，运行账号无 DDL）
- 安装 / 升级 / 回滚 / 一致性备份 / 校验恢复 runbook 与脚本

## Helm 起步

见 [`deploy/helm/README.md`](./helm/README.md)。默认假设 Postgres / Qdrant / Redis
由客户托管；chart 部署 web / api / lifecycle-worker / outbox-worker，并可显式启用
DBOS cleanup worker/control（+ 可选 Ingress / 迁移 Job / PVC）。

## 试点冒烟

```bash
# 离线（不需要 Compose）：隔离单测 + CI 质量门禁
./deploy/compose/scripts/pilot-preflight.sh

# Compose 已 up 且 bootstrap.env（或 .smoke-admin-password）含真实 admin 密码：
cd deploy/compose
./scripts/pilot-smoke.sh
# 退出 0=PASS；1=FAIL；2=SKIP（栈未起 / 无模型 key 等）
```

完整签字流程：[`docs/runbooks/pilot-acceptance.md`](../docs/runbooks/pilot-acceptance.md)。

## 供应链 / SBOM（薄说明）

`release-images.yml` 已对 web / api / migrator / outbox / DBOS worker 五张发布镜像执行 Trivy
`HIGH/CRITICAL` CVE 门禁；扫描未通过时不产出 release manifest。完整 SBOM、签名和
证明材料仍后置。交付前：

1. 确认 `deploy/config/runtime.env.example` / Helm values 中基础镜像 tag 已 pin；
2. 使用 workflow 产出的 digest manifest 部署，并归档对应 Trivy 日志；
3. 客户要求 SBOM / 签名时另行运行 `syft` / `cosign`（或客户等价工具）。

## 明确后置

| 项 | 说明 |
|---|---|
| Helm 容量 / HPA / PDB / NetworkPolicy | starter 未纳入；按客户集群硬化 |
| SBOM 生成与镜像签名 | CVE 镜像扫描已接入发布 CI；SBOM / Cosign 后置 |
| 客户自有 registry promotion | ACR + GHCR 已双推并产出 digest；TCR/Harbor 按客户策略后置 |
| MinIO/S3 一等公民对象后端 | 默认共享卷 / PVC；S3 适配另开 |

生产验收以 `docs/acceptance/` 的部署级 go/no-go 签字为准；仅有部署包不能宣称 production-ready。
