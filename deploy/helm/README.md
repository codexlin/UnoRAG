# UnoRAG Helm chart

Kubernetes starter for customer private deployments. Complements
[`deploy/compose/`](../compose/) — Compose remains the single-node reference;
this starter chart targets multi-replica deployments with **external**
Postgres / Qdrant / Redis and a shared `ReadWriteMany` documents PVC. S3/MinIO
is not yet a supported storage adapter.

## Layout

```text
deploy/helm/unorag/
  Chart.yaml
  values.yaml
  templates/
    web-deployment.yaml / web-service.yaml
    api-deployment.yaml / api-service.yaml   # ClusterIP only
    worker-deployment.yaml                   # lifecycle-worker
    outbox-worker-deployment.yaml            # outbox-worker（必需）
    dbos-deployments.yaml                    # 可选 StatefulSet executor + control
    configmap.yaml / secret.yaml / pvc.yaml
    ingress.yaml
    migrate-jobs.yaml                        # opt-in Helm hooks
```

## Prerequisites

1. Customer-managed PostgreSQL, Qdrant, Redis (chart does not install them).
2. Runtime Secret `unorag-runtime` (or override `secret.existingSecret`) with
   DSNs and auth secrets — see `helm status` NOTES / values comments.
3. Built images pushed to a registry the cluster can pull (`images.*.repository`
   and `migrate.web.image.repository`).
4. StorageClass that supports `ReadWriteMany` if using the shared documents PVC
   (or `persistence.existingClaim` / disable PVC when S3 lands).

## Install sketch

```bash
# Create namespace + secret first (do not commit secret YAML with real values)
kubectl create namespace unorag
kubectl -n unorag create secret generic unorag-runtime \
  --from-literal=UNORAG_INTERNAL_SECRET=... \
  --from-literal=UNORAG_SESSION_SECRET=... \
  --from-literal=INTERNAL_AUTH_SECRET=... \
  --from-literal=UNORAG_ADMIN_PASSWORD=... \
  --from-literal=DATABASE_URL=postgresql://unorag_web_login:...@... \
  --from-literal=OUTBOX_DATABASE_URL=postgresql://unorag_outbox_login:...@... \
  --from-literal=API_DATABASE_URL=postgresql+psycopg://unorag_api_login:...@... \
  --from-literal=WORKER_DATABASE_URL=postgresql://unorag_worker_login:...@... \
  --from-literal=RAG_READ_DATABASE_URL=postgresql://unorag_rag_api_login:...@... \
  --from-literal=DBOS_SYSTEM_DATABASE_URL=postgresql://... \
  --from-literal=MIGRATOR_DATABASE_URL=postgresql://...

# Optional: enable migration Jobs for this install
helm upgrade --install unorag ./deploy/helm/unorag \
  -n unorag \
  --atomic \
  --wait \
  --set images.web.repository=registry.example/unorag-web \
  --set images.web.tag=1.0.0 \
  --set images.api.repository=registry.example/unorag-api \
  --set images.api.tag=1.0.0 \
  --set images.outbox.repository=registry.example/unorag-web-outbox \
  --set images.outbox.tag=1.0.0 \
  --set images.dbosWorker.repository=registry.example/unorag-web-worker \
  --set images.dbosWorker.tag=1.0.0 \
  --set migrate.web.image.repository=registry.example/unorag-web-migrator \
  --set migrate.web.image.tag=1.0.0 \
  --set external.qdrant.url=http://qdrant.infra:6333 \
  --set external.redis.url=redis://redis.infra:6379 \
  --set migrate.web.enabled=true \
  --set migrate.rag.enabled=true \
  --set dbos.enabled=false \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=unorag.example.com
```

## Fail-closed edge

- Ingress (when enabled) only fronts **web**.
- **api** 仅通过 ClusterIP 在集群内暴露；**lifecycle-worker**、**outbox-worker**
  与可选 **DBOS control** 不创建 Service。DBOS worker 仅创建 headless Service
  以稳定 StatefulSet identity，均不对外暴露。
- `dbos.enabled=true` 前必须准备独立 DBOS system database；它不能和业务
  `DATABASE_URL` 指向同一个数据库。
- PostgreSQL 管理员必须预建固定登录角色
  `unorag_web_login`、`unorag_outbox_login`、`unorag_api_login`、
  `unorag_worker_login`、`unorag_rag_api_login`，并分别授予同名职责组
  `unorag_web`、`unorag_outbox`、`unorag_api`、`unorag_worker`、
  `unorag_rag_read`。PostgreSQL 16+ 授权时使用 `WITH SET FALSE`，并保持
  `ADMIN FALSE` / `INHERIT TRUE`；每个 login 只能直属一个职责组。
  `migrate.runtimeRoles.enabled=true` 会重放 grants，并
  使用每个 Secret DSN 验证实际 principal 与 role membership；不匹配则发布失败。
- `dbos.applicationVersion` 是 workflow 兼容版本，不是任意镜像 tag；只有
  workflow 契约不兼容时才升级，并须先处理旧版本非终态 workflow。
- Production flags default to gate-on / legacy-writes-off (see `values.yaml` `config`).
- With `migrate.web.enabled=true`, an ACL hook uses the dedicated outbox image
  to backfill legacy restricted ACL fingerprints and waits for every Qdrant
  projection to converge. The first compatibility upgrade must keep
  `config.dbosAclProjectionEnabled=false` while deploying the capable DBOS
  worker; its bootstrap gate runs post-upgrade, so pause ACL administration for
  that rollout. Enable the flag in a second release. From then on the same gate
  runs pre-upgrade, before Kubernetes changes application workloads.
- Always use `--atomic --wait` for customer upgrades. A projection timeout
  fails the release instead of leaving a partially adopted workload set.

## Explicitly deferred

| Item | Notes |
|---|---|
| SBOM / image signing | Release workflow already gates CVEs; SBOM / Cosign remain deferred |
| Customer-registry promotion | ACR/GHCR manifests are digest-locked; TCR/Harbor promotion remains deferred |
| Bundled Postgres/Qdrant/Redis | Customer-managed; no Bitnami subcharts in this starter |
| MinIO/S3 first-class PVC alternative | `external.objectStorage: s3` stub; adapter WIP |
| Capacity / HPA / PDB / NetworkPolicy | Add in hardening pass |

Runbook section: [`docs/runbooks/private-deployment.md`](../../docs/runbooks/private-deployment.md) § Helm.
