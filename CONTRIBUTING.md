# Contributing to UnoRAG

Thank you for helping improve UnoRAG. Contributions should strengthen the single
open-source product rather than introduce commercial feature gates or customer-only
policy into the public core.

## Before opening a change

1. Search existing issues and discussions.
2. Open an issue before a large behavior, schema, API, dependency, or architecture
   change. Security reports must follow `SECURITY.md` instead.
3. Keep customer data, credentials, internal hostnames and proprietary documents out
   of issues, commits, fixtures and screenshots.
4. For architecture decisions, update or add an ADR under `docs/adr/`.

## Development workflow

Use Node.js 22 and pnpm 9. Install and verify from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:ts-core
pnpm test
pnpm lint
pnpm build
```

Tests that need PostgreSQL, Qdrant, ParserProvider or model access must use isolated
test infrastructure. A skipped environment-dependent test is not release evidence.
See `docs/DEVELOPMENT.md` for repository boundaries and `docs/RELEASE.md` for the
full acceptance matrix.

## Pull requests

- Keep changes focused and preserve public HTTP and lifecycle contracts unless the
  change explicitly versions them.
- Add tests proportional to risk, especially for authorization, version activation,
  deletion, retrieval filters, citations and recovery.
- Update user-facing and operational documentation in the same change.
- Run `git diff --check` and the relevant commands above.
- Explain migration, compatibility, privacy and rollback impact.
- Confirm that contributed code and assets are yours to submit under the repository
  license once it is adopted.

By contributing, you agree that your contribution may be distributed under the
project's adopted license. The repository is still preparing for its first
open-source license; contributions must not be merged under an ambiguous grant.
