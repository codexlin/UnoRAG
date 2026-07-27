"""Ask 编排图（Data Plane）。

输入：有效 Ask 请求 + effective settings（含 ask_overrides / policy snapshot）
输出：AskResponse（答案、引用、trace/debug）
不变量：产品 knobs 不读 HYBRID_ENABLED 等 env；门禁与检索计划走既有合同
所有者：Data Plane / Ask

Facade：兼容 re-export（含 ``build_ask_graph`` 自 ``builder``）。请求生命周期见 service.py
（prepare_request → execute_graph/stream_graph → finalize_result）。
"""

from __future__ import annotations

from app.graph.builder import build_ask_graph
from app.graph.lifecycle import (
	append_temp_session_memory,
	history_from_thread,
	load_request_history,
	memory_session_id,
	resolve_request_ids,
)
from app.graph.messages import (
	build_generate_messages,
	history_for_generate,
	question_with_working_memory,
	rewrite_with_history,
)
from app.graph.persistence import persist_turn, single_document_version_id
from app.graph.context import AskGraphContext, build_ask_graph_context
from app.graph.nodes.common import (  # noqa: F401 — re-export for tests / monkeypatch
	_library_label,
	_merge_debug,
	_renumber_citation_indexes,
)
from app.graph.nodes.generation import (  # noqa: F401 — re-export helpers used by tests/service
	_finalize_generation_output,
	_format_context,
	_format_generate_context,
	_format_table_generate_context,
	_table_execution_context_block,
	_to_citation_models,
)
from app.graph.nodes.rewrite import (  # noqa: F401 — facade re-export; impl lives in nodes.rewrite
	_request_structured_retrieval_plan_json,
)
from app.graph.state import AskState, GenerateFn, LoadTableGroupsFn, RetrieveFn
from app.graph.stubs import (
	STUB_CITATIONS,
	stub_generate,
	stub_load_table_groups,
	stub_retrieve,
)
from app.graph.service import (  # noqa: F401 — public service API
	AskGraphService,
	FinalizedAskResult,
	PreparedAskRequest,
)

# Re-export extracted symbols so existing `from app.graph.ask_graph import …` keeps working.
# Underscore aliases keep legacy monkeypatches on ask_graph._persist_turn / _history_from_thread.
_persist_turn = persist_turn
_history_from_thread = history_from_thread
_single_document_version_id = single_document_version_id

__all__ = [
	"AskGraphContext",
	"AskGraphService",
	"AskState",
	"FinalizedAskResult",
	"GenerateFn",
	"LoadTableGroupsFn",
	"PreparedAskRequest",
	"RetrieveFn",
	"STUB_CITATIONS",
	"build_ask_graph_context",
	"append_temp_session_memory",
	"build_ask_graph",
	"build_generate_messages",
	"history_for_generate",
	"history_from_thread",
	"load_request_history",
	"memory_session_id",
	"persist_turn",
	"question_with_working_memory",
	"resolve_request_ids",
	"rewrite_with_history",
	"single_document_version_id",
	"stub_generate",
	"stub_load_table_groups",
	"stub_retrieve",
]
