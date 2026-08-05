# UnoRAG 私有化部署包

本目录是客户可安装的私有部署参考包。主机需要 Docker、Docker Compose 和 Python 3
（仅供配置迁移与验收脚本使用，产品镜像不含 Python 运行时）。首片以 **Docker Compose 单机拓扑** 为主；
**Helm/K8s 起步骨架** 已提供；镜像 CVE 扫描已进入发布门禁，SBOM 与签名后置。

产品定位见 [`docs/PRODUCT.md`](../docs/PRODUCT.md)，安装与生产验收分别见
[`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) 和 [`docs/RELEASE.md`](../docs/RELEASE.md)。

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
      upgrade.sh            # 四镜像 pull、迁移、DBOS/Web 滚动升级
      observability-smoke.sh # 可选 Ops Stack 数据源与容器健康检查
      backup.sh             # 维护窗口：PostgreSQL / DBOS / 对象 / Qdrant 冷备
      restore.sh            # 恢复（需显式确认）
      pilot-preflight.sh    # 隔离单测 + CI gate（可无 Compose）
      pilot-smoke.sh        # upload→ask→replace→delete 冒烟
  postgres/                 # 最小权限运行角色与验证 SQL
  docker/
    web.Dockerfile
  helm/
    README.md               # Helm 安装说明
    unorag/                 # chart：web / DBOS worker / migrator / ops
```

## 快速开始

完整步骤见 [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md)。

```bash
cd deploy/compose
./scripts/init-config.sh
# 编辑 ../config/runtime.env、runtime.secret、bootstrap.env

./scripts/install.sh
# 浏览器：http://localhost/
# 就绪：curl -sf http://localhost/api/rag/health/ready
```

需要官方单机 Ops Stack 时使用 `./scripts/install.sh --with-observability`。它提供 Collector、
Prometheus/Grafana、Loki/Tempo 和 Alertmanager，Grafana 仅绑定宿主机回环地址；默认安装不启动这些
组件，也不增加核心运行依赖。

已有独立 Langfuse 项目时可使用 `./scripts/install.sh --with-langfuse`，由 Collector 仅把脱敏 Trace
双写到 Langfuse。UnoRAG 不内置 Langfuse 的 ClickHouse/Redis/对象存储；完整配置见
[`docs/LANGFUSE.md`](../docs/LANGFUSE.md)。

根目录 `docker-compose.yml` 仍只提供本机联调基础设施（Postgres/Qdrant/Redis）。
客户式全栈安装请使用 `deploy/compose/`。

## 本片已覆盖

- Compose 参考拓扑（Caddy → web；DBOS worker/control 与数据存储仅内网）
- 客户托管连接与模型 endpoint（全部经环境变量）
- secret 仅从环境注入；镜像不含密钥
- production fail-closed 与 readiness 说明
- migration 独立步骤（migrator 凭据，运行账号无 DDL）
- 安装 / 升级 / 回滚 / 一致性备份 / 校验恢复 runbook 与脚本
- restricted ACL 双指纹门禁、可重入回填与升级前零 pending 检查
- 可选、具备进程资源限制和有限保留期的 OTel Ops Stack，以及外部 Collector 标准接口（磁盘配额由部署基础设施负责）

## Helm 起步

见 [`deploy/helm/README.md`](./helm/README.md)。默认假设 Postgres / Qdrant / Redis
由客户托管；chart 部署 web、DBOS worker/control、迁移 Job 与 ops 能力
（+ 可选 Ingress / PVC）。迁移使用职责分离镜像；Helm 客户升级必须使用
`--atomic --wait`，并在切流前确认 lifecycle 与 ACL projection 收敛。

## 试点冒烟

```bash
# 离线（不需要 Compose）：隔离单测 + CI 质量门禁
./deploy/compose/scripts/pilot-preflight.sh

# Compose 已 up 且 bootstrap.env（或 .smoke-admin-password）含真实 admin 密码：
cd deploy/compose
./scripts/pilot-smoke.sh
# 退出 0=PASS；1=FAIL；2=SKIP（栈未起 / 无模型 key 等）
```

完整签字流程：[`docs/RELEASE.md`](../docs/RELEASE.md)。

## 供应链 / SBOM（薄说明）

`release-images.yml` 已对 web / migrator / ops / DBOS worker 四张发布镜像执行 Trivy
`HIGH/CRITICAL` CVE 门禁；扫描未通过时不产出 release manifest。完整 SBOM、签名和
证明材料仍后置。交付前：

1. 确认 `deploy/config/runtime.env.example` / Helm values 中基础镜像 tag 已 pin；
2. 使用 workflow 产出的 digest manifest 部署，并归档对应 Trivy 日志；
3. 客户要求 SBOM / 签名时另行运行 `syft` / `cosign`（或客户等价工具）。

发布 manifest 同时携带 `UNORAG_IMAGE_PLATFORM`。`v0.1` 当前固定为 `linux/amd64`；Compose 安装和
升级会在拉取前校验 Docker Engine 架构。架构不一致不得作为客户生产部署，仅本地验收可使用产品服务
overlay 配合显式 `--allow-platform-emulation`。

## 明确后置

| 项 | 说明 |
|---|---|
| Helm 容量 / HPA / PDB / NetworkPolicy | starter 未纳入；按客户集群硬化 |
| SBOM 生成与镜像签名 | CVE 镜像扫描已接入发布 CI；SBOM / Cosign 后置 |
| 客户自有 registry promotion | ACR + GHCR 已双推并产出 digest；TCR/Harbor 按客户策略后置 |
| MinIO/S3 一等公民对象后端 | 默认共享卷 / PVC；S3 适配另开 |

生产验收以 [`docs/RELEASE.md`](../docs/RELEASE.md) 的部署级 go/no-go 签字为准；
仅有部署包不能宣称 production-ready。
