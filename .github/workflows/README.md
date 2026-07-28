# UnoRAG CI/CD workflows

| Workflow | Role (P0) |
|----------|-----------|
| [`ci.yml`](./ci.yml) | **PR + main** entrypoint: lint-diff, eval-gates, full API pytest, web test/lint/build, Docker build-verify (no push). `permissions: contents: read` only. |
| [`eval-gates.yml`](./eval-gates.yml) | Reusable L7 deterministic release gate + Py↔JS policy parity. Called by `ci.yml`. |
| [`release-images.yml`](./release-images.yml) | Manual/tag build of three image targets; one build per target is pushed to ACR + GHCR, gated by Trivy `HIGH/CRITICAL` image scans, and emitted as regional digest manifests. Real push requires ACR secrets and `dry_run=false`. |
| `promote-images.yml` | **Not in repo yet** — TCR/Harbor promote deferred. |
| `deploy.yml` | **Deferred** — human-approved SSH deploy after `upgrade.sh` pull path is proven. |

See [`docs/ops/cicd-p0.md`](../docs/ops/cicd-p0.md).

Do not commit registry passwords, SSH keys, or production `.env` files.
