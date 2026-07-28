# UnoRAG Helm chart (L8 starter)

Kubernetes starter for customer private deployments. Complements
[`deploy/compose/`](../compose/) — Compose remains the single-node reference;
this chart targets multi-replica production with **external** Postgres / Qdrant /
Redis / object storage.

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
    configmap.yaml / secret.yaml / pvc.yaml
    ingress.yaml
    migrate-jobs.yaml                        # opt-in Helm hooks
```

## Prerequisites

1. Customer-managed PostgreSQL, Qdrant, Redis (chart does not install them).
2. Runtime Secret `unorag-runtime` (or override `secret.existingSecret`) with
   DSNs and auth secrets — see `helm status` NOTES / values comments.
3. Built images pushed to a registry the cluster can pull (`images.*.repository`).
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
  --from-literal=DATABASE_URL=postgresql://... \
  --from-literal=API_DATABASE_URL=postgresql+psycopg://... \
  --from-literal=WORKER_DATABASE_URL=postgresql://... \
  --from-literal=RAG_READ_DATABASE_URL=postgresql://... \
  --from-literal=MIGRATOR_DATABASE_URL=postgresql://...

# Optional: enable migration Jobs for this install
helm upgrade --install unorag ./deploy/helm/unorag \
  -n unorag \
  --set images.web.repository=registry.example/unorag-web \
  --set images.web.tag=1.0.0 \
  --set images.api.repository=registry.example/unorag-api \
  --set images.api.tag=1.0.0 \
  --set external.qdrant.url=http://qdrant.infra:6333 \
  --set external.redis.url=redis://redis.infra:6379 \
  --set migrate.web.enabled=true \
  --set migrate.rag.enabled=true \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=unorag.example.com
```

## Fail-closed edge

- Ingress (when enabled) only fronts **web**.
- **api** 仅通过 ClusterIP 在集群内暴露；**lifecycle-worker** 与 **outbox-worker** 不创建 Service，三者均不对外暴露（均为私有部署必需进程）。
- Production flags default to gate-on / legacy-writes-off (see `values.yaml` `config`).

## Explicitly deferred

| Item | Notes |
|---|---|
| SBOM / CVE image scan | Document-only; pin tags and wire CI later |
| Image digest locking | Prefer digest after registry promotion |
| Bundled Postgres/Qdrant/Redis | Customer-managed; no Bitnami subcharts in this starter |
| MinIO/S3 first-class PVC alternative | `external.objectStorage: s3` stub; adapter WIP |
| Capacity / HPA / PDB / NetworkPolicy | Add in hardening pass |

Runbook section: [`docs/runbooks/private-deployment.md`](../../docs/runbooks/private-deployment.md) § Helm.
