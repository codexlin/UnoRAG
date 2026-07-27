# MinerU 302 Provider Real Smoke — 2026-07-27

## Scope

Validate the real 302.AI MinerU 2.5 protocol and the MeriKnow provider adapter
without persisting the temporary credential.

## Fixture

- `testdata/ab/crosstable-large.pdf`
- size: 64,840 bytes
- sha256:
  `3942f1be2ed07fc20549914d8199ac207b4bf91c1bbc826a38a7244f9477aa80`
- parse method: `auto`
- provider version: `2.5`

## Result

| Check | Result |
|---|---|
| `POST /302/upload-file` | PASS |
| `POST /302/v2/mineru/task` returns task id | PASS |
| `GET /302/v2/mineru/task` reaches `SUCCESS` | PASS |
| Result ZIP contains `*_content_list.json` | PASS |
| Provider adapter converts ZIP to `DocumentIR` | PASS — 6 nodes |
| Structured Chinese table text preserved | PASS |
| Parser report stamps provider/version/external | PASS — `302ai` / `2.5` / `true` |
| API key written to repository or env files | NO |

The live result download was also verified through the production adapter, not
only with raw `curl`. The temporary key was held in a one-time shell process and
unset when the smoke completed.

## Security and lifecycle behavior

- External parsing requires `EXTERNAL_PARSER_ALLOWED=true`.
- The credential is injected as `MINERU_302_API_KEY` from runtime Secret into
  the lifecycle worker only (not API/Web).
- Only provider/task/status/poll count are persisted in job payload.
- Pending tasks release the worker lease and resume later without consuming a
  job attempt.
- Result URLs must use HTTPS and a trusted 302 host; the Bearer credential is
  not forwarded to the result-file host.
- Polling stops at `MINERU_302_MAX_WAIT_S`.

## Automated evidence

- API pytest: **315 passed, 8 skipped**
- deterministic release gate: **36/36 PASS**
- Compose interpolation/config validation: **PASS**
