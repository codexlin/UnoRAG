# Quality Release Gates

Golden-set eval is the publish contract. Scores alone never override a fuse.

## Modes

| Mode | When | Command |
|---|---|---|
| `ci` | Every PR | Cases tagged `ci` (deterministic stub Ask / chunk / retrieval) |
| `release` | Release candidate | Full `tests/eval/eval_cases.jsonl` |

```bash
cd apps/api

# PR / local fast gate
uv run python scripts/run_release_gates.py --mode ci \
  --baseline tests/eval/baselines/ci-deterministic.json \
  --report-out /tmp/unorag-ci-gate.json

# Release candidate
uv run python scripts/run_release_gates.py --mode release \
  --baseline tests/eval/baselines/release.json \
  --report-out /tmp/unorag-release-gate.json
```

CI：`.github/workflows/ci.yml`（PR + `main` 入口）调用可复用工作流
`.github/workflows/eval-gates.yml`（deterministic + policy parity）。
全量 API pytest / web / Docker 构建验证也在 `ci.yml`。见
[`docs/ops/cicd.md`](../ops/cicd.md)。

## Layers

| Layer | Case kinds |
|---|---|
| routing | `classify` |
| answer | `ask` |
| ingestion | `ingest_chunk`, `ingest_http` |
| retrieval | `retrieval` |

Baseline floors live in `tests/eval/baselines/*.json`. A layer pass_rate below
its floor blocks the gate unless `--allow-regression` is explicitly passed
(recorded in the report). Fuse trips are never soft-passed.

## Hard fuses (must stay 0 failures)

Cases tagged `fuse` / `isolation` / `acl` / `tenant_leak` /
`inactive_generation` / `deleted_generation`, plus ask cases that expect
`refused=true`, are hard fuses:

- tenant/workspace/group leak
- section pollution into fact retrieval (`isolation`)
- refusal contracts (no_hit / weak_match / ambiguous)

## Report contract

Reports use schema `unorag.release_gate.v1` and record:

- git commit
- dataset path + sha256
- ask/embedding/hybrid/rerank/gate config
- dependency versions
- per-layer metrics, fuse list, baseline compare, failing case observations

Failed online feedback must be added to `eval_cases.jsonl` before a baseline
floor is raised.
