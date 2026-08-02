# TypeScript MinerU 302.AI Live Acceptance

**Date:** 2026-08-02

**Runtime:** local private-deployment Compose topology

**Fixture:** `testdata/pdf/leave-scanned.pdf`

## Result

PASS. The product upload endpoint accepted a real scanned PDF and the DBOS worker
completed the 302.AI upload, task polling, ZIP download, MinerU normalization,
embedding, Qdrant staging, activation, and library cleanup path.

| Check | Result |
|---|---|
| Browser-facing upload accepted asynchronously | PASS |
| DBOS `ingest-auto` queue consumed the PDF | PASS |
| 302.AI upload and MinerU task completed | PASS |
| Job terminal state | `completed`, stage `done` |
| Parser report | `parser=mineru`, `provider=302ai` |
| External processing disclosure | `external_data_processing=true` |
| Full provider task id persisted in parser report | No |
| Qdrant staging and activation | PASS |
| Idempotent test-library cleanup | PASS |

## Defects Closed During Acceptance

1. Deployment workers listened only to local and lifecycle queues, leaving auto and
   MinerU jobs accepted but unconsumed. Compose and Helm now require all four queues
   and expose independent concurrency limits.
2. The TypeScript adapter omitted the live `result_url` success field. The adapter
   now accepts that field and retains compatibility aliases.
3. The runtime worker lacked `SELECT` on the newly created active-generation view.
   The migration now grants the view explicitly.
4. The parser report retained the full external task id. The 302.AI adapter now
   removes it before persistence.

## Remaining Provider Work

- cost and daily-budget release controls;
- structured provider latency/error metrics and alert packaging;
- restart-at-submit fault injection to prove external billing idempotency.

No credentials, provider task identifiers, or signed result URLs are stored in this
report.
