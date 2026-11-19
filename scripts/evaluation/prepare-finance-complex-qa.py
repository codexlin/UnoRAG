#!/usr/bin/env python3
"""Curate a cost-bounded FinanceComplexQA CN benchmark batch under .unorag/hf-eval/."""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE = ROOT / ".unorag" / "hf-eval" / "finance_complex_qa"
DEFAULT_OUT = ROOT / ".unorag" / "hf-eval" / "batch_cn_v1"

SCENES = [
    "Bank_Financial_Statements",
    "Corporate_Financial_Report",
    "Customer_Service_Records",
    "FinTech_Research_Report",
    "Investment_Strategy_Report",
    "Market_Trend_Analysis_Report",
    "Supervision_and_Compliance_Audit",
]

OUTPUT_FORMAT_RE = re.compile(r"\n+###\s*输出格式[\s\S]*$")
CONCLUSION_HEAD_RE = re.compile(
    r"(?:###\s*(?:✅\s*)?(?:最终)?(?:结论|总结|正式回答)|最终答案为|综上所述[，,:：])"
)
UNANSWERABLE_VERDICT_RE = re.compile(
    r"(?:无法(?:准确|有效|唯一)?(?:回答|判断|确定|比较|计算|得出(?:准确)?(?:结论|结果))"
    r"|因此[，,]?\s*无法(?:判断|比较|回答|确定|计算)"
    r"|在当前文档范围内\s*\*{0,2}无解\*{0,2}"
    r"|文档中?(?:完全)?(?:未|没有)提供足够的(?:信息|数据)"
    r"|文档中?(?:完全)?(?:未|没有)提供(?:任何|足够的).*?(?:因此|故|所以|无法)"
    r"|(?:缺少|缺乏)足够的.*?(?:因此|无法))"
)
NUMBER_RE = re.compile(r"(?<![A-Za-z0-9])\d[\d,]*(?:\.\d+)?%?")
CN_PHRASE_RE = re.compile(r"[\u4e00-\u9fff]{2,8}")
EN_TOKEN_RE = re.compile(r"\b[A-Za-z][A-Za-z0-9._-]{2,20}\b")
STOP_TERMS = {
    "根据", "提供", "文档", "内容", "主要", "包括", "方面", "如下", "具体", "以及",
    "其中", "通过", "可以", "进行", "相关", "因此", "但是", "如果", "由于", "公司",
    "企业", "规定", "方法", "问题", "分析", "报告", "情况", "数据", "以上", "以下",
    "应当", "必须", "不得", "或者", "其他", "不同", "相比", "因素", "分别", "例如",
}


def pdf_page_count(pdf_path: Path) -> int:
    output = subprocess.check_output(
        ["pdfinfo", str(pdf_path)], text=True, stderr=subprocess.DEVNULL
    )
    match = re.search(r"Pages:\s+(\d+)", output)
    return int(match.group(1)) if match else 999


def pdf_full_text(pdf_path: Path) -> str:
    return subprocess.check_output(
        ["pdftotext", str(pdf_path), "-"], text=True, stderr=subprocess.DEVNULL
    )


def flatten_gold(gold: object) -> list[str]:
    items: list[str] = []
    if isinstance(gold, list):
        for entry in gold:
            items.extend(flatten_gold(entry))
    elif gold is not None:
        text = str(gold).strip()
        if text:
            items.append(text)
    return items


def extract_key_signals(gold_texts: list[str]) -> tuple[list[str], list[str]]:
    joined = "\n".join(gold_texts)
    raw_nums = NUMBER_RE.findall(joined)
    numbers: list[str] = []
    for num in raw_nums:
        cleaned = num.replace(",", "")
        # Skip plain 1-digit list indices like "1" unless percentage/decimal
        if len(cleaned) == 1 and "." not in cleaned and "%" not in cleaned:
            continue
        if num not in numbers:
            numbers.append(num)
        if len(numbers) >= 8:
            break

    terms: list[str] = []
    for token in EN_TOKEN_RE.findall(joined) + CN_PHRASE_RE.findall(joined):
        if token in STOP_TERMS or len(token) < 2:
            continue
        if token not in terms:
            terms.append(token)
        if len(terms) >= 8:
            break
    return numbers, terms


def clean_question(text: str) -> str:
    return OUTPUT_FORMAT_RE.sub("", text).strip()


def is_unanswerable_gold(gold_texts: list[str]) -> bool:
    joined = "\n".join(gold_texts).strip()
    if not joined:
        return False
    matches = list(CONCLUSION_HEAD_RE.finditer(joined))
    verdict_slice = joined[matches[-1].start() :] if matches else joined[-320:]
    return bool(UNANSWERABLE_VERDICT_RE.search(verdict_slice))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--max-pages", type=int, default=440)
    parser.add_argument("--max-per-pdf-pages", type=int, default=28)
    parser.add_argument("--negative-count", type=int, default=10)
    args = parser.parse_args()

    refs_root = args.source_dir / "refs" / "CN"
    qa_files = sorted((args.source_dir / "pro" / "CN" / "task_categories").glob("*/*.jsonl"))
    if not refs_root.exists() or not qa_files:
        raise SystemExit(
            f"Missing extracted FinanceComplexQA dataset under {args.source_dir}"
        )

    pdf_by_stem: dict[str, Path] = {}
    pdf_by_scene_stem: dict[tuple[str, str], Path] = {}
    for pdf in sorted(refs_root.rglob("*.pdf")):
        rel_parts = pdf.relative_to(refs_root).parts
        if len(rel_parts) >= 2:
            pdf_by_scene_stem[(rel_parts[0], pdf.stem)] = pdf
        pdf_by_stem.setdefault(pdf.stem, pdf)

    qa_by_pdf: dict[Path, list[dict]] = defaultdict(list)
    seen_ids: set[str] = set()
    for qa_file in qa_files:
        with qa_file.open(encoding="utf-8") as handle:
            for line in handle:
                row = json.loads(line)
                qid = row["finqa_id"]
                if qid in seen_ids:
                    continue
                seen_ids.add(qid)
                stem = Path(row["Reference_documents"]).stem
                doc_type = str(row.get("doc_type") or "")
                pdf_path = pdf_by_scene_stem.get((doc_type, stem)) or pdf_by_stem.get(stem)
                if not pdf_path:
                    continue
                row["_clean_q"] = clean_question(row["question"])
                qa_by_pdf[pdf_path].append(row)

    pages = {pdf: pdf_page_count(pdf) for pdf in qa_by_pdf}
    ranked = sorted(qa_by_pdf.items(), key=lambda kv: (-len(kv[1]), pages[kv[0]], kv[0].name))

    selected: list[tuple[Path, list[dict]]] = []
    selected_paths: set[Path] = set()
    total_pages = 0

    for scene in SCENES:
        for pdf, rows in ranked:
            if pdf in selected_paths:
                continue
            if rows[0].get("doc_type") == scene and pages[pdf] <= max(30, args.max_per_pdf_pages):
                if total_pages + pages[pdf] <= args.max_pages:
                    selected.append((pdf, rows))
                    selected_paths.add(pdf)
                    total_pages += pages[pdf]
                    break

    for pdf, rows in ranked:
        if pdf in selected_paths:
            continue
        if pages[pdf] > args.max_per_pdf_pages:
            continue
        if total_pages + pages[pdf] > args.max_pages:
            continue
        selected.append((pdf, rows))
        selected_paths.add(pdf)
        total_pages += pages[pdf]

    corpus_text = "\n".join(pdf_full_text(pdf) for pdf, _ in selected)

    # Pick negative questions whose company/entity does not appear anywhere in the selected 21 PDFs
    negatives: list[dict] = []
    used_companies: set[str] = set()
    for pdf, rows in ranked:
        if pdf in selected_paths:
            continue
        for row in rows:
            company = str(row.get("_cluster_institution") or "").strip()
            q = row["_clean_q"]
            if len(company) < 3 or company in used_companies:
                continue
            if company not in q:
                continue
            if company in corpus_text:
                continue
            used_companies.add(company)
            negatives.append(
                {
                    "id": f"neg-{row['finqa_id']}",
                    "polarity": "negative",
                    "refusal_kind": "out_of_corpus",
                    "question": q,
                    "excluded_entity": company,
                    "source_doc": pdf.name,
                    "task_type": row["task_type"],
                    "doc_type": row.get("doc_type", "unknown"),
                }
            )
            break
        if len(negatives) >= args.negative_count:
            break

    pdfs_out = args.out_dir / "pdfs"
    pdfs_out.mkdir(parents=True, exist_ok=True)
    for old_pdf in pdfs_out.glob("*.pdf"):
        old_pdf.unlink()

    cases: list[dict] = []
    in_corpus_refusals: list[dict] = []
    task_counts: Counter[str] = Counter()
    scene_counts: Counter[str] = Counter()
    manifest_docs: list[dict] = []

    for pdf, rows in selected:
        target_pdf = pdfs_out / pdf.name
        shutil.copy2(pdf, target_pdf)
        answerable_for_pdf = 0
        for row in rows:
            gold_texts = flatten_gold(row.get("gold"))
            task_type = row["task_type"]
            doc_type = row.get("doc_type", "unknown")
            if is_unanswerable_gold(gold_texts):
                in_corpus_refusals.append(
                    {
                        "id": f"neg-in-{row['finqa_id']}",
                        "polarity": "negative",
                        "refusal_kind": "in_corpus_unanswerable",
                        "question": row["_clean_q"],
                        "excluded_entity": None,
                        "source_doc": pdf.name,
                        "task_type": task_type,
                        "doc_type": doc_type,
                        "gold": gold_texts,
                    }
                )
                continue
            answerable_for_pdf += 1
            numbers, terms = extract_key_signals(gold_texts)
            task_counts[task_type] += 1
            scene_counts[doc_type] += 1
            cases.append(
                {
                    "id": row["finqa_id"],
                    "polarity": "positive",
                    "file": pdf.name,
                    "question": row["_clean_q"],
                    "gold": gold_texts,
                    "expected_numbers": numbers,
                    "expected_terms": terms,
                    "task_type": task_type,
                    "doc_type": doc_type,
                    "company": row.get("company_with_period", ""),
                }
            )
        manifest_docs.append(
            {
                "file": pdf.name,
                "pages": pages[pdf],
                "qa_count": answerable_for_pdf,
                "doc_type": rows[0].get("doc_type", "unknown"),
            }
        )

    all_negatives = negatives + in_corpus_refusals
    cases.extend(all_negatives)
    cases_path = args.out_dir / "cases.jsonl"
    with cases_path.open("w", encoding="utf-8") as handle:
        for item in cases:
            handle.write(json.dumps(item, ensure_ascii=False) + "\n")

    manifest = {
        "dataset": "Multilingual-Multimodal-NLP/FinanceComplexQA (CN curated)",
        "document_count": len(manifest_docs),
        "total_pages": total_pages,
        "positive_count": len(cases) - len(all_negatives),
        "negative_count": len(all_negatives),
        "out_of_corpus_negative_count": len(negatives),
        "in_corpus_unanswerable_count": len(in_corpus_refusals),
        "task_types": dict(task_counts),
        "scenes": dict(scene_counts),
        "documents": manifest_docs,
    }
    (args.out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps({k: v for k, v in manifest.items() if k != "documents"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
