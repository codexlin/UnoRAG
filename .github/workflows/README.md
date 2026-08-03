# UnoRAG CI/CD workflows

| Workflow | Role |
|----------|-----------|
| [`ci.yml`](./ci.yml) | **PR + main** entrypoint: lint-diff, TypeScript release gates, Web test/lint/build, live scorer tests, and Docker build verification. |
| [`release-images.yml`](./release-images.yml) | Manual/tag build of four Node targets (web, migrator, ops, DBOS worker), published to ACR + GHCR and scanned with Trivy. |
| `promote-images.yml` | **Not in repo yet** — TCR/Harbor promote deferred. |
| `deploy.yml` | **Deferred** — human-approved SSH deploy after `upgrade.sh` pull path is proven. |

See [`docs/OPERATIONS.md`](../../docs/OPERATIONS.md).

Do not commit registry passwords, SSH keys, or production `.env` files.
