# MeriKnow CI/CD workflows

| Workflow | Role (P0) |
|----------|-----------|
| [`ci.yml`](./ci.yml) | **PR + main** entrypoint: lint-diff, eval-gates, full API pytest, web test/lint/build, Docker build-verify (no push). `permissions: contents: read` only. |
| [`eval-gates.yml`](./eval-gates.yml) | Reusable L7 deterministic release gate + Py↔JS policy parity. Called by `ci.yml`. |
| [`release-images.yml`](./release-images.yml) | **Skeleton**: manual/tag build of three image targets. ACR push requires secrets — dry-run by default; **not** production-ready. |
| `promote-images.yml` | **Not in repo yet** — TCR/Harbor promote deferred. |
| `deploy.yml` | **Deferred** — human-approved SSH deploy after `upgrade.sh` pull path is proven. |

See [`docs/ops/cicd-p0.md`](../docs/ops/cicd-p0.md).

Do not commit registry passwords, SSH keys, or production `.env` files.
