# MeriKnow 私有化部署包（L8 + L9 入口）

本目录是客户可安装的私有部署参考包。首片以 **Docker Compose 单机拓扑** 为主；
**Helm/K8s 起步骨架** 已提供；SBOM/镜像安全扫描仍后置。

产品定位与开工 checklist：[`docs/PRODUCT.md`](../docs/PRODUCT.md) ·
[`docs/ROADMAP.md`](../docs/ROADMAP.md)。  
试点 go/no-go 见 [`docs/acceptance/`](../docs/acceptance/README.md)。

## 目录

```text
deploy/
  README.md                 # 本文件
  compose/
    docker-compose.yml      # 单机参考拓扑
    env.example             # 环境变量模板（复制为 .env）
    Caddyfile               # 反向代理：仅暴露控制面
    scripts/
      install.sh            # 安装：infra → migrate → app
      upgrade.sh            # 滚动升级（含 worker drain）
      backup.sh             # PostgreSQL / 对象 / Qdrant
      restore.sh            # 恢复（需显式确认）
      pilot-preflight.sh    # L9：隔离单测 + CI gate（可无 Compose）
      pilot-smoke.sh        # L9：upload→ask→replace→delete 冒烟
  docker/
    api.Dockerfile
    web.Dockerfile
  helm/
    README.md               # Helm 安装说明
    meriknow/               # chart：web / api / lifecycle-worker
```

## 快速开始

完整步骤与验收见 [`docs/runbooks/private-deployment.md`](../docs/runbooks/private-deployment.md)。

```bash
cd deploy/compose
cp env.example .env
# 编辑 .env：密钥、模型 endpoint、数据库口令

./scripts/install.sh
# 浏览器：http://localhost/
# 健康：curl -sf http://localhost/api/rag/health
```

根目录 `docker-compose.yml` 仍只提供本机联调基础设施（Postgres/Qdrant/Redis）。
客户式全栈安装请使用 `deploy/compose/`。

## 本片已覆盖

- Compose 参考拓扑（Caddy → web；api/worker 仅内网）
- 客户托管连接与模型 endpoint（全部经环境变量）
- secret 仅从环境注入；镜像不含密钥
- production fail-closed 与 readiness 说明
- migration 独立步骤（migrator 凭据，运行账号无 DDL）
- 安装 / 升级 / 回滚 / 备份 / 恢复 runbook 与脚本

## Helm 起步

见 [`deploy/helm/README.md`](./helm/README.md)。默认假设 Postgres / Qdrant / Redis
由客户托管；chart 只部署 web / api / worker（+ 可选 Ingress / 迁移 Job / PVC）。

## 试点冒烟（L9）

```bash
# 离线（不需要 Compose）：隔离单测 + CI 质量门禁
./deploy/compose/scripts/pilot-preflight.sh

# Compose 已 up 且 .env 含真实 admin 密码：
cd deploy/compose
./scripts/pilot-smoke.sh
# 退出 0=PASS；1=FAIL；2=SKIP（栈未起 / 无模型 key 等）
```

完整签字流程：[`docs/runbooks/pilot-acceptance.md`](../docs/runbooks/pilot-acceptance.md)。

## 供应链 / SBOM（薄说明）

完整 SBOM + CVE 扫描流水线仍后置，不阻塞通用受控试点 P0。交付前建议：

1. 确认 `env.example` / values 中基础镜像 tag 已 pin；  
2. 对构建出的 `meriknow-web` / `meriknow-api` 镜像自行运行 `syft` / `trivy`（或客户等价工具）并归档；  
3. 未扫描时写入发布「已知限制」，勿暗示已完成镜像安全认证。

## 明确后置

| 项 | 说明 |
|---|---|
| Helm 容量 / HPA / PDB / NetworkPolicy | starter 未纳入；按客户集群硬化 |
| SBOM 生成与依赖/镜像扫描 | 需接入 CI；Compose/Helm 已 pin 镜像 tag |
| 镜像 digest 锁定与私有 registry 推送 | 客户环境按 registry 策略固化 |
| MinIO/S3 一等公民对象后端 | 默认共享卷 / PVC；S3 适配另开 |

生产验收以 `docs/acceptance/` 的部署级 go/no-go 签字为准；仅有部署包不能宣称 production-ready。
