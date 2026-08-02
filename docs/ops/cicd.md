# CI/CD And Release Images

UnoRAG publishes four Node images from one source tree:

| Target | Image suffix | Purpose |
|---|---|---|
| `runner` | `web-TAG` | Next.js product and Knowledge API |
| `migrator` | `migrator-TAG` | forward-only Drizzle migrations |
| `ops` | `ops-TAG` | bootstrap, inspection and backfill |
| `worker` | `worker-TAG` | DBOS executor and control |

## Workflows

| Workflow | Gate |
|---|---|
| `.github/workflows/ci.yml` | Web tests, TS core tests, typecheck, lint, migration check and four Docker targets |
| `.github/workflows/eval-gates.yml` | reusable native RAG and control-plane test gate |
| `.github/workflows/release-images.yml` | ACR/GHCR publish, Trivy HIGH/CRITICAL scan and digest manifest |

No workflow uses `pull_request_target`. Deployment credentials belong in GitHub
Environment or registry secrets, never application source.

## Local Release

```bash
brew install just
docker login REGISTRY

just check
just images v0.1.0
just release v0.1.0 REGISTRY/NAMESPACE
```

The release writes `dist/release/release-registry.env` containing:

```dotenv
UNORAG_WEB_IMAGE=...@sha256:...
UNORAG_WEB_MIGRATOR_IMAGE=...@sha256:...
UNORAG_WEB_OPS_IMAGE=...@sha256:...
UNORAG_DBOS_WORKER_IMAGE=...@sha256:...
UNORAG_DBOS_APPLICATION_VERSION=lifecycle-v2
```

Floating `latest` tags are rejected.

## Deploy

```bash
cd deploy/compose
./scripts/backup.sh ./backups/pre-upgrade
./scripts/upgrade.sh --manifest /path/to/release-registry.env
```

Upgrade order is pull, forward migration, role verification, DBOS roll, ACL
reconciliation, Web roll, health and pilot smoke. Previous image pins are stored in
`.upgrade-state/previous-images.env`. A failed application roll restores those pins;
the database is never automatically down-migrated.

Formal production delivery still requires an approved target-environment deployment,
backup/restore drill, fault injection, capacity baseline, monitoring ownership and a
version-bound go/no-go report.
