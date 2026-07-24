# AB fixtures (`testdata/ab/`)

Chunk-profile / layout stress set for A/B eval. Golds live in `golds.jsonl`.
Legacy eval fixtures stay under `testdata/{pdf,docx,md,txt,unsupported}/` — do not replace them.

| File | Mode (golds) | Purpose |
|------|--------------|---------|
| `contract-long.docx` | `precise` | Long contract clauses → precise splits / fact recall |
| `quote-big-80rows.docx` | `table_heavy` | 80-row quote table → row-group chunking |
| `crosstable-large.pdf` | `table_heavy` | Large crosstab PDF → table_heavy extraction |
| `report-narrative-5k.md` | `narrative` | ~5k narrative prose → narrative / semantic breaks |
| `scan-lowcontrast.pdf` | `scan_ocr` (scan) | Low-contrast scan → OCR / MinerU path |
| `twocolumn.pdf` | `twocolumn` | Two-column layout → reading-order / layout |
| `mixed-charts.pdf` | `mixed_charts` (charts) | Figures + charts mixed with text |
| `golds.jsonl` | — | Gold Q/A + mode + file hints for AB eval |

Run the profile A/B suite from `apps/api`:

```bash
uv run python scripts/ab_chunk_profiles.py
```

The runner loads this directory and `golds.jsonl` directly. Generated reports
land in `apps/api/.eval_reports/`; one-off live outputs under `_e2e_out/` are
ignored. Keep old `testdata/pdf/leave-scanned.pdf` etc. for the 39-case core
golden eval, MinerU controls, and unsupported-file negatives.
