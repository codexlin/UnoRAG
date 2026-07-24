# MeriKnow 私有化部署包（L8）

本目录是客户可安装的私有部署参考包。首片以 **Docker Compose 单机拓扑** 为主；
Kubernetes/Helm 与 SBOM/镜像安全扫描见下方「后置」。

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
  docker/
    api.Dockerfile
    web.Dockerfile
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

## 明确后置（未纳入本片）

| 项 | 说明 |
|---|---|
| Kubernetes / Helm chart | 生产容量参数与多副本拓扑待下一片 |
| SBOM 生成与依赖/镜像扫描 | 需接入 CI 流水线；Compose 已 pin 镜像 tag |
| 镜像 digest 锁定与私有 registry 推送 | 客户环境按 registry 策略固化 |
| MinIO/S3 一等公民对象后端 | 当前默认共享卷 `DOCUMENT_STORAGE_ROOT`；S3 适配另开 |

生产验收仍以路线图 L8 Done 与 L9 试点为准。
