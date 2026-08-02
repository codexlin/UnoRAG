# Quality Release Gates

UnoRAG separates deterministic code gates from live release acceptance. A score
cannot override an isolation, authorization, inactive-generation, or refusal fuse.

## Deterministic Gates

Run from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm test:ts-core
pnpm typecheck
pnpm lint
pnpm db:check
NEXT_TELEMETRY_DISABLED=1 pnpm build
```

The Web suite covers product, authorization, HTTP, schema, deployment, and UI
contracts. The TS core suite covers routing, refusal, parsers, DocumentIR/TableIR,
chunking, retrieval scope, Qdrant projection, DBOS workflows, and lifecycle failure
semantics. Environment-dependent PostgreSQL and Qdrant tests are allowed to skip
locally but must run during release acceptance.

CI entrypoints:

- `.github/workflows/ci.yml`
- `.github/workflows/eval-gates.yml`
- `.github/workflows/release-images.yml`

## Live Gates

Start from the private-deployment Compose topology and run:

```bash
cd deploy/compose
source scripts/compose-env.sh
mk_compose up -d --wait
./scripts/pilot-smoke.sh
mk_compose --profile ops run --rm inspect-lifecycle
```

A release candidate must additionally record:

1. representative real-file ingest, including digital and scanned PDF;
2. Retrieve/Ask citations, refusal, table execution, and latency;
3. cross-organization, workspace, principal, and group zero leakage;
4. replacement failure preserving the previous active generation;
5. cancellation, deletion, cleanup, worker restart, and Qdrant fault recovery;
6. backup/restore and upgrade/rollback evidence;
7. browser workflows for owner, admin, editor, and viewer roles.

## Hard Fuses

These must remain at zero failures:

- cross-scope or ACL leakage;
- inactive, superseded, or deleted generation recall;
- unsupported answers returned without refusal;
- citations that do not support the answer;
- table execution without complete contributing evidence;
- dead or stuck lifecycle jobs at release completion.

Reference corpora remain under `eval/reference/`. They become release evidence only
when executed through the current product HTTP boundary and bound to the candidate
commit, image digests, configuration fingerprint, and dated acceptance report.
