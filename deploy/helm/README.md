# UnoRAG Helm Chart

Kubernetes starter for private deployments with customer-managed PostgreSQL,
Qdrant and Redis. The chart deploys the same four-image topology as Compose:

- `web`: product edge and native Retrieve/Ask;
- `dbosWorker`: durable lifecycle executor and control loop;
- `migrator`: opt-in Drizzle and role migration jobs;
- `ops`: opt-in inspection and ACL reconciliation jobs.

Only Web receives an Ingress. DBOS admin, PostgreSQL, Qdrant, Redis and
ParserProvider endpoints remain private.

## Prerequisites

1. PostgreSQL application and DBOS system databases.
2. Qdrant and Redis reachable from the namespace.
3. A `ReadWriteMany` document PVC, or a private Tencent COS bucket.
4. Four pinned images in a registry the cluster can pull.
5. A runtime Secret with least-privilege DSNs and provider credentials.

Required Secret keys:

```text
UNORAG_SESSION_SECRET
DATABASE_URL
WORKER_DATABASE_URL
DBOS_SYSTEM_DATABASE_URL
MIGRATOR_DATABASE_URL
LLM_API_KEY
OIDC_CLIENT_SECRET          # optional; required when auth.oidc.enabled=true
MINERU_API_KEY             # optional, self-hosted or 302.AI MinerU auth
OTEL_EXPORTER_OTLP_HEADERS # optional, customer Collector authentication
COS_SECRET_ID              # required only for objectStorage.driver=cos
COS_SECRET_KEY             # required only for objectStorage.driver=cos
COS_SECURITY_TOKEN         # optional temporary STS credential
```

The application and DBOS system DSNs must not point to the same database.

Enterprise OIDC is configured under `auth` in `values.yaml`. Register
`<auth.appBaseUrl>/api/auth/oidc/callback` at the IdP and keep local auth enabled
as the controlled break-glass path. See [authentication](../../docs/AUTHENTICATION.md).

For Tencent COS, keep the bucket private and disable the document PVC:

```bash
helm upgrade --install unorag ./deploy/helm/unorag \
  --set objectStorage.driver=cos \
  --set objectStorage.cos.bucket=example-1250000000 \
  --set objectStorage.cos.region=ap-hongkong \
  --set objectStorage.cos.publicBaseUrl=https://cos.example.com \
  --set persistence.enabled=false
```

Original-document downloads continue through UnoRAG session, Workspace, and
document ACL checks. The branded COS domain does not need public bucket access.

## Install Sketch

```bash
helm upgrade --install unorag ./deploy/helm/unorag \
  --namespace unorag --create-namespace \
  --atomic --wait \
  --set secret.existingSecret=unorag-runtime \
  --set images.web.repository=registry.example/unorag-web \
  --set images.web.tag=1.0.0 \
  --set images.dbosWorker.repository=registry.example/unorag-worker \
  --set images.dbosWorker.tag=1.0.0 \
  --set images.migrator.repository=registry.example/unorag-migrator \
  --set images.migrator.tag=1.0.0 \
  --set images.ops.repository=registry.example/unorag-ops \
  --set images.ops.tag=1.0.0 \
  --set external.qdrant.url=http://qdrant.infra:6333 \
  --set external.redis.url=redis://redis.infra:6379 \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=unorag.example.com
```

Run schema migration as a controlled release step by enabling the migration jobs
defined in [`values.yaml`](./unorag/values.yaml). Migrations are forward-only;
application rollback switches image pins and does not down-migrate data.

## External OpenTelemetry Collector

The chart does not install Grafana, Prometheus, Loki, Tempo, or Alertmanager.
Kubernetes deployments should send telemetry to the customer's existing
Collector or APM endpoint:

```bash
helm upgrade --install unorag ./deploy/helm/unorag \
  --set config.openaiBaseUrl=http://llm \
  --set observability.otel.enabled=true \
  --set observability.otel.endpoint=http://otel-collector.monitoring:4318
```

The chart fails rendering when telemetry is enabled without an endpoint. The
optional `OTEL_EXPORTER_OTLP_HEADERS` Secret key is injected only into runtime
pods. Telemetry is fail-soft and must never become an application readiness
dependency.

For Langfuse, configure a v4 OTLP exporter on the customer-managed Collector.
Do not inject Langfuse project keys into UnoRAG pods. See
[`docs/LANGFUSE.md`](../../docs/LANGFUSE.md).

## Validate

```bash
helm lint deploy/helm/unorag --set config.openaiBaseUrl=http://llm
helm template unorag deploy/helm/unorag \
  --set config.openaiBaseUrl=http://llm >/tmp/unorag.yaml
```

See the [private deployment guide](../../docs/DEPLOYMENT.md)
and [operations guide](../../docs/OPERATIONS.md).
