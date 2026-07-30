"""Export deterministic Python IR fixtures consumed by TypeScript contracts."""

from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path

from app.graph.state import AskState
from app.services.ingest.ir import DocumentIR, Node, NodeType, ParserReport
from app.services.ingest.table_ir import (
	TableCell,
	TableColumn,
	TableIR,
	TableQualityReport,
	TableRow,
)

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_DOCUMENT_OUTPUT = (
	ROOT / "apps" / "web" / "tests" / "fixtures" / "ts-core"
	/ "python-document-ir-v1.json"
)
DEFAULT_ASK_OUTPUT = (
	ROOT / "apps" / "web" / "tests" / "fixtures" / "ts-core"
	/ "python-ask-contract-v1.json"
)
ASK_TOPOLOGY = ROOT / "apps" / "api" / "app" / "graph" / "topology.py"


def build_fixture() -> DocumentIR:
	table = TableIR(
		table_id="table-contract-1",
		page_start=1,
		page_end=2,
		caption="Supplier quotes",
		header_rows=[["Supplier", "Quote (CNY)"]],
		columns=[
			TableColumn(
				name="Supplier",
				normalized_name="Supplier",
				data_type="string",
			),
			TableColumn(
				name="Quote (CNY)",
				normalized_name="Quote",
				data_type="currency",
				unit="CNY",
			),
		],
		rows=[
			TableRow(
				cells=[
					TableCell(
						raw_text="Example Ltd.",
						normalized_value="Example Ltd.",
						page=1,
						bbox=[10.0, 20.0, 40.0, 30.0],
						confidence=0.98,
					),
					TableCell(
						raw_text="125000",
						normalized_value=125000,
						page=1,
						bbox=[40.0, 20.0, 70.0, 30.0],
						confidence=0.99,
					),
				]
			)
		],
		quality_report=TableQualityReport(
			score=0.99,
			executable=True,
			expected_columns=2,
			cross_page_merged=True,
		),
	)
	return DocumentIR(
		id="document-contract-1",
		library_id="library-contract-1",
		source="fixture://python-document-ir-v1",
		source_format="pdf",
		title="Contract fixture",
		filename="contract-fixture.pdf",
		content_hash="0123456789abcdef0123456789abcdef",
		version=1,
		nodes=[
			Node(
				id="node-heading-1",
				type=NodeType.HEADING,
				path="Commercial terms",
				level=1,
				page_start=1,
				page_end=1,
				text="Commercial terms",
				confidence=0.99,
			),
			Node(
				id="node-table-1",
				type=NodeType.TABLE,
				path="Commercial terms",
				page_start=1,
				page_end=2,
				text="Supplier quotes",
				table_json={
					"headers": ["Supplier", "Quote (CNY)"],
					"rows": [["Example Ltd.", "125000"]],
				},
				table_ir=table,
				table_id=table.table_id,
				confidence=0.98,
				meta={"reading_order": 1},
			),
			Node(
				id="node-figure-1",
				type=NodeType.FIGURE,
				path="Commercial terms",
				page_start=2,
				page_end=2,
				text="Figure 1",
				figure_desc="Price comparison chart",
				figure_id="figure-contract-1",
				confidence=0.9,
			),
		],
		parser_report=ParserReport(
			source_format="pdf",
			parser="contract-fixture",
			backend="python",
			parser_version="1.0",
			mode="hybrid",
			latency_ms=12.5,
			text_pages=[1],
			vlm_pages=[2],
			metrics={"node_count": 3, "table_count": 1},
		),
		meta={"contract_version": "document-ir-v1"},
	)


def serialized_document_fixture() -> str:
	payload = build_fixture().model_dump(mode="json")
	return json.dumps(payload, ensure_ascii=False, indent="\t", sort_keys=True) + "\n"


def serialized_ask_fixture() -> str:
	tree = ast.parse(ASK_TOPOLOGY.read_text(encoding="utf-8"))
	node_names: list[str] = []
	for node in ast.walk(tree):
		if not isinstance(node, ast.Call):
			continue
		if not isinstance(node.func, ast.Attribute) or node.func.attr != "add_node":
			continue
		if not node.args:
			continue
		name = node.args[0]
		if isinstance(name, ast.Constant) and isinstance(name.value, str):
			node_names.append(name.value)
	payload = {
		"contract_version": "ask-graph-v1",
		"node_names": node_names,
		"state_fields": list(AskState.__annotations__),
	}
	return json.dumps(payload, ensure_ascii=False, indent="\t", sort_keys=True) + "\n"


def main() -> int:
	parser = argparse.ArgumentParser()
	parser.add_argument("--document-output", type=Path, default=DEFAULT_DOCUMENT_OUTPUT)
	parser.add_argument("--ask-output", type=Path, default=DEFAULT_ASK_OUTPUT)
	parser.add_argument("--check", action="store_true")
	args = parser.parse_args()
	fixtures = {
		args.document_output: serialized_document_fixture(),
		args.ask_output: serialized_ask_fixture(),
	}

	if args.check:
		stale = [
			path for path, expected in fixtures.items()
			if not path.exists() or path.read_text(encoding="utf-8") != expected
		]
		if stale:
			raise SystemExit(f"fixtures are stale: {', '.join(map(str, stale))}")
		return 0

	for path, expected in fixtures.items():
		path.parent.mkdir(parents=True, exist_ok=True)
		path.write_text(expected, encoding="utf-8")
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
