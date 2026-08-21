# UnoRAG CI/CD workflows

| Workflow | Role |
|----------|-----------|
| [`ci.yml`](./ci.yml) | **PR + main** entrypoint: lint-diff, TypeScript evaluation and release gates, real PostgreSQL/Qdrant/Redis integration tests, Web test/lint/build, and Docker build verification. |
| [`release-images.yml`](./release-images.yml) | Manual/tag build of four Node targets (web, migrator, ops, DBOS worker), published to GHCR, optionally mirrored to ACR, scanned with Trivy, and accompanied by SBOM/provenance attestations. |

See [`docs/OPERATIONS.md`](../../docs/OPERATIONS.md).

Customer-registry promotion is deployment-specific. Production deployment is intentionally not triggered by a generic
repository workflow: an operator reviews the digest manifest and runs the documented `upgrade.sh` path inside the customer
boundary. A future deployment workflow must preserve that approval and credential boundary rather than embedding SSH
credentials in the public product repository.

Do not commit registry passwords, SSH keys, or production `.env` files.
