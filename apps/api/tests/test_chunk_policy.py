"""Phase 2D chunk policy, semantic fallback, and observability tests."""

from __future__ import annotations

from app.services.ingest.chunker import ChunkerConfig, chunk_document
from app.services.ingest.ir import DocumentIR, Node, NodeType, SplitStrategy
from app.services.ingest.parsers.md import parse_markdown
from app.services.ingest.parsers.txt import parse_txt
from app.services.ingest.pipeline import chunks_to_payloads, prepare_ingest
from app.settings import Settings


def _narrative() -> str:
	return "\n\n".join(
		[
			"财务制度要求员工保存原始发票。报销申请应在月底前提交。",
			"财务负责人审核费用归属。预算超限时需要补充审批。",
			"安全制度要求进入机房登记。值班人员每天检查消防设备。",
			"安全事件发生后应立即上报。负责人需要保留处置记录。",
		]
	)


def _topic_embedder(texts: list[str]) -> list[list[float]]:
	return [[1.0, 0.0] if "财务" in text or "报销" in text or "预算" in text else [0.0, 1.0] for text in texts]


def test_structure_strategies_win_and_emit_policy_metadata() -> None:
	doc = parse_markdown(
		content="""# 手册

## 请假

病假须提交证明。

| 类型 | 天数 |
| --- | --- |
| 年假 | 5 |

```python
print("hello")
```
""".encode(),
		filename="handbook.md",
		title="员工手册",
	)
	chunks = chunk_document(
		doc,
		config=ChunkerConfig(semantic_enabled=True, semantic_min_chars=100),
		semantic_embedder=_topic_embedder,
	)

	strategies = {chunk.split_strategy for chunk in chunks}
	assert SplitStrategy.HEADING in strategies
	assert SplitStrategy.TABLE in strategies
	assert SplitStrategy.CODE in strategies
	assert SplitStrategy.SEMANTIC not in strategies
	assert all(chunk.meta["chunk_policy_version"] == "v1" for chunk in chunks)
	assert all(chunk.meta["chunk_profile"] == "balanced" for chunk in chunks)
	assert all(chunk.meta["split_reason"] for chunk in chunks)
	assert doc.parser_report.metrics["chunking"]["chunk_count"] == len(chunks)


def test_long_unstructured_narrative_uses_semantic_boundaries() -> None:
	doc = parse_txt(content=_narrative().encode(), filename="policy.txt", title="制度")
	chunks = chunk_document(
		doc,
		config=ChunkerConfig(
			chunk_size=100,
			chunk_overlap=10,
			profile_name="narrative",
			semantic_enabled=True,
			semantic_min_chars=100,
			semantic_break_percentile=90,
		),
		semantic_embedder=_topic_embedder,
	)

	assert len(chunks) >= 2
	assert all(chunk.split_strategy == SplitStrategy.SEMANTIC for chunk in chunks)
	assert all(chunk.meta["split_reason"] == "unstructured_long_narrative" for chunk in chunks)
	assert all(chunk.meta["semantic_unit_count"] >= 4 for chunk in chunks)
	assert doc.parser_report.metrics["chunking"]["strategies"] == {"semantic": len(chunks)}


def test_semantic_unavailable_and_error_fall_back_to_recursive() -> None:
	config = ChunkerConfig(
		chunk_size=100,
		chunk_overlap=10,
		semantic_enabled=True,
		semantic_min_chars=100,
	)
	unavailable_doc = parse_txt(
		content=_narrative().encode(),
		filename="unavailable.txt",
		title="制度",
	)
	unavailable = chunk_document(unavailable_doc, config=config)
	assert all(chunk.split_strategy == SplitStrategy.RECURSIVE for chunk in unavailable)
	assert all(
		chunk.meta["split_reason"] == "semantic_unavailable_fallback"
		for chunk in unavailable
	)

	def broken_embedder(_: list[str]) -> list[list[float]]:
		raise TimeoutError("embedding timeout")

	error_doc = parse_txt(content=_narrative().encode(), filename="error.txt", title="制度")
	fallback = chunk_document(
		error_doc,
		config=config,
		semantic_embedder=broken_embedder,
	)
	assert all(chunk.split_strategy == SplitStrategy.RECURSIVE for chunk in fallback)
	assert all(chunk.meta["split_reason"] == "semantic_error_fallback" for chunk in fallback)
	assert all(chunk.meta["semantic_fallback"] == "TimeoutError" for chunk in fallback)
	assert error_doc.parser_report.metrics["chunking"]["fallback_count"] == len(fallback)


def test_table_heavy_profile_controls_table_record_row_groups() -> None:
	rows = [[str(index), f"item-{index}"] for index in range(45)]
	doc = DocumentIR(
		id="doc-table",
		source_format="md",
		title="费用表",
		nodes=[
			Node(
				id="table-node",
				type=NodeType.TABLE,
				text="",
				table_id="t1",
				table_json={"headers": ["序号", "项目"], "rows": rows},
			)
		],
	)
	chunks = chunk_document(
		doc,
		config=ChunkerConfig(profile_name="table_heavy"),
	)
	payloads = chunks_to_payloads(
		chunks,
		doc_id=doc.id,
		include_sections=False,
	)
	table_records = [item for item in payloads if item["record_type"] == "table"]

	assert len(table_records) == 3
	assert [(item["row_start"], item["row_end"]) for item in table_records] == [
		(0, 19),
		(20, 39),
		(40, 44),
	]
	chunk_payload = next(item for item in payloads if item["record_type"] == "chunk")
	assert chunk_payload["chunk_profile"] == "table_heavy"
	assert chunk_payload["split_reason"] == "structured_table"
	assert chunk_payload["table_rows_per_record"] == 20


def test_prepare_ingest_injects_semantic_embedder_without_network() -> None:
	settings = Settings(
		ingest_pipeline="v2",
		ask_mode="stub",
		metadata_backend="json",
		chunk_size=100,
		chunk_overlap=10,
		chunking_profile="narrative",
		semantic_chunking_enabled=True,
		semantic_chunk_min_chars=100,
		semantic_chunk_break_percentile=90,
	)
	prepared = prepare_ingest(
		settings=settings,
		filename="policy.txt",
		content=_narrative().encode(),
		library_id="lib-policy",
		semantic_embedder=_topic_embedder,
	)

	assert prepared.chunks
	assert all(chunk.split_strategy == SplitStrategy.SEMANTIC for chunk in prepared.chunks)


def test_precise_profile_really_produces_finer_recursive_chunks() -> None:
	text = "。".join(f"第{index}条制度内容需要完整保留并用于检索" for index in range(30)) + "。"
	balanced_doc = parse_txt(content=text.encode(), filename="balanced.txt", title="制度")
	precise_doc = parse_txt(content=text.encode(), filename="precise.txt", title="制度")

	balanced = chunk_document(
		balanced_doc,
		config=ChunkerConfig(chunk_size=300, chunk_overlap=20, profile_name="balanced"),
	)
	precise = chunk_document(
		precise_doc,
		config=ChunkerConfig(chunk_size=300, chunk_overlap=20, profile_name="precise"),
	)

	assert len(precise) > len(balanced)
	assert all(chunk.meta["target_chars"] == 195 for chunk in precise)


def test_precise_pdf_page_keeps_whole_page_when_over_target_within_max() -> None:
	"""force_page + precise: length in (target, max] stays one PAGE chunk, not recursive."""
	# precise target = round(300 * 0.65) = 195; max = 300
	page_body = ("页内制度条款需要完整保留。" * 16).strip()
	assert 195 < len(page_body) <= 300

	doc = DocumentIR(
		id="doc-page",
		source_format="pdf",
		title="制度PDF",
		nodes=[
			Node(
				id="page-1",
				type=NodeType.PAGE,
				text=page_body,
				page_start=1,
				page_end=1,
				path="第1页",
			)
		],
	)
	chunks = chunk_document(
		doc,
		config=ChunkerConfig(chunk_size=300, chunk_overlap=20, profile_name="precise"),
	)

	assert len(chunks) == 1
	assert chunks[0].split_strategy == SplitStrategy.PAGE
	assert chunks[0].meta["split_reason"] == "page_boundary"
	assert chunks[0].body == page_body
	assert chunks[0].meta["target_chars"] == 195
	assert chunks[0].meta["max_chars"] == 300


def test_precise_pdf_page_over_max_recursive_splits() -> None:
	"""force_page + over max_chars: recursive split, not PAGE label."""
	page_body = ("超长页内容需要递归切分。" * 40).strip()
	assert len(page_body) > 300

	doc = DocumentIR(
		id="doc-page-over",
		source_format="pdf",
		title="制度PDF",
		nodes=[
			Node(
				id="page-1",
				type=NodeType.PAGE,
				text=page_body,
				page_start=1,
				page_end=1,
				path="第1页",
			)
		],
	)
	chunks = chunk_document(
		doc,
		config=ChunkerConfig(chunk_size=300, chunk_overlap=20, profile_name="precise"),
	)

	assert len(chunks) > 1
	assert all(chunk.split_strategy == SplitStrategy.RECURSIVE for chunk in chunks)
	assert all(chunk.meta["split_reason"] == "page_over_max" for chunk in chunks)
