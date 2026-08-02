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

Run the live profile A/B suite from the repository root against a running product:

```bash
UNORAG_BASE_URL=http://127.0.0.1:8088 python3 scripts/run_ab_live_e2e.py
```

The runner loads this directory and `golds.jsonl` directly. Generated reports
land under `_e2e_out/` and are ignored. Keep old `testdata/pdf/leave-scanned.pdf`
and related fixtures for MinerU controls and unsupported-file negatives.
