# Security Policy

## Supported versions

Security fixes are made against the latest supported UnoRAG release. Until the
first stable release, only the current `main` branch and newest release candidate
receive fixes.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or include customer data,
credentials, prompts, retrieved content, logs, or exploit details in a public post.

Use GitHub's private vulnerability reporting for this repository. Include:

- the affected version, commit, or image digest;
- the deployment topology and relevant configuration with secrets removed;
- clear reproduction steps and expected impact;
- whether tenant, workspace, ACL, document, or generation isolation is affected;
- any temporary mitigation already applied.

If private vulnerability reporting is unavailable, contact the repository owner
privately through their GitHub profile and ask for a secure reporting channel. Do
not send sensitive material until that channel is confirmed.

The maintainers will acknowledge a complete report, assess severity, coordinate a
fix and disclosure, and credit the reporter when requested. Response-time or repair
commitments exist only under a separate support agreement.

## Security boundaries

UnoRAG treats the following as release-blocking security properties:

- organization, workspace, user-group and document ACL isolation;
- server-derived Qdrant filters and active-generation selection;
- fail-closed authentication on externally reachable deployments;
- protection of model, parser, storage, database and observability credentials;
- idempotent lifecycle recovery without exposing deleted or inactive content.

See `docs/ARCHITECTURE.md`, `docs/RELEASE.md` and `docs/OPERATIONS.md` for the
current design and verification requirements.
