"""Business-intent policy profile → internal knobs."""

from __future__ import annotations

from app.services.ask_defaults import ASK_DEFAULTS
from app.services.ask_overrides import (
	effective_ask_settings,
	extract_ask_policy_snapshot,
	resolve_overrides_to_knobs,
)
from app.services.policy_profiles import (
	PUBLIC_ASK_DEFAULTS,
	migrate_legacy_ask_to_public,
	resolve_ask_policy,
	resolve_document_policy,
	resolve_parse_plan,
)
from app.settings import Settings


def test_balanced_defaults_match_ask_defaults() -> None:
	resolved = resolve_ask_policy(PUBLIC_ASK_DEFAULTS)
	assert resolved.retrieve_top_k == ASK_DEFAULTS.retrieve_top_k
	assert resolved.answer_min_score == ASK_DEFAULTS.answer_min_score
	assert resolved.hybrid_enabled is ASK_DEFAULTS.hybrid_enabled
	assert resolved.rerank_enabled is ASK_DEFAULTS.rerank_enabled
	assert resolved.citation_adjudicate_enabled is ASK_DEFAULTS.citation_adjudicate_enabled


def test_precise_and_exploratory_profiles() -> None:
	precise = resolve_ask_policy({**PUBLIC_ASK_DEFAULTS, "answer_profile": "precise"})
	exploratory = resolve_ask_policy(
		{**PUBLIC_ASK_DEFAULTS, "answer_profile": "exploratory"}
	)
	assert precise.retrieve_top_k < exploratory.retrieve_top_k
	assert precise.answer_min_score > exploratory.answer_min_score


def test_evidence_requirement_stricter_wins() -> None:
	base = {**PUBLIC_ASK_DEFAULTS, "answer_profile": "exploratory"}
	relaxed = resolve_ask_policy({**base, "evidence_requirement": "relaxed"})
	strict = resolve_ask_policy({**base, "evidence_requirement": "strict"})
	assert strict.answer_min_score >= 0.5
	assert strict.answer_min_score > relaxed.answer_min_score
	assert strict.citation_adjudicate_enabled is True


def test_retrieval_enhancement_modes() -> None:
	off = resolve_ask_policy({**PUBLIC_ASK_DEFAULTS, "retrieval_enhancement": "off"})
	on = resolve_ask_policy({**PUBLIC_ASK_DEFAULTS, "retrieval_enhancement": "on"})
	auto = resolve_ask_policy(
		{**PUBLIC_ASK_DEFAULTS, "retrieval_enhancement": "auto"},
		question="合同编号 HT-2024-001",
	)
	assert (off.hybrid_enabled, off.rerank_enabled) == (False, False)
	assert (on.hybrid_enabled, on.rerank_enabled) == (True, True)
	assert (auto.hybrid_enabled, auto.rerank_enabled) == (True, True)


def test_migrate_legacy_knobs() -> None:
	public = migrate_legacy_ask_to_public(
		{
			"retrieve_top_k": 4,
			"answer_min_score": 0.55,
			"hybrid_enabled": True,
			"rerank_enabled": True,
			"citation_adjudicate_absolute_floor": 0.45,
		}
	)
	assert public["answer_profile"] == "precise"
	assert public["retrieval_enhancement"] == "on"
	assert public["evidence_requirement"] == "strict"


def test_ask_overrides_accept_public_and_legacy() -> None:
	base = Settings(_env_file=None)
	public_effective = effective_ask_settings(
		base,
		{"answer_profile": "precise", "retrieval_enhancement": "on"},
	)
	assert public_effective.retrieve_top_k == 4
	assert public_effective.hybrid_enabled is True

	legacy_effective = effective_ask_settings(
		base,
		{"retrieve_top_k": 3, "hybrid_enabled": True},
	)
	assert legacy_effective.retrieve_top_k == 3
	assert legacy_effective.hybrid_enabled is True

	knobs = resolve_overrides_to_knobs(
		{
			"answer_profile": "balanced",
			"_ask_policy": {"public": PUBLIC_ASK_DEFAULTS, "policy_version": 2},
		}
	)
	assert "retrieve_top_k" in knobs
	assert extract_ask_policy_snapshot(
		{"_ask_policy": {"policy_version": 2}}
	) == {"policy_version": 2}


def test_document_profile_mapping() -> None:
	assert resolve_document_policy(document_profile="table_heavy").chunk_profile == (
		"table_heavy"
	)
	assert resolve_document_policy(document_profile="regulatory").chunk_profile == (
		"precise"
	)
	assert resolve_document_policy(document_profile="narrative").semantic_enabled is True
	assert resolve_document_policy(scan_handling="disabled").ocr_enabled is False
	assert (
		resolve_document_policy(scan_handling="disabled").enhanced_parser_allowed
		is False
	)
	assert resolve_document_policy(scan_handling="force_ocr").ocr_enabled is True
	assert (
		resolve_document_policy(scan_handling="force_ocr").enhanced_parser_allowed
		is True
	)
	assert resolve_document_policy(scan_handling="auto").ocr_enabled is None
	assert (
		resolve_document_policy(parse_preference="local_only").enhanced_parser_allowed
		is False
	)
	assert (
		resolve_document_policy(parse_preference="quality").prefer_enhanced is True
	)


def test_parse_plan_intents_vs_deploy_flags() -> None:
	"""User intents × deploy flags → fail-closed plan (no provider selection)."""
	auto = resolve_parse_plan(
		parse_preference="auto",
		scan_handling="auto",
		mineru_enabled=True,
		mineru_provider="self_hosted",
		external_parser_allowed=False,
	)
	assert auto.enhanced_parser_allowed is True
	assert auto.prefer_enhanced is False
	assert auto.external_processing_allowed is False
	assert auto.degrade_reason is None

	quality_ok = resolve_parse_plan(
		parse_preference="quality",
		mineru_enabled=True,
		mineru_provider="self_hosted",
		external_parser_allowed=False,
	)
	assert quality_ok.enhanced_parser_allowed is True
	assert quality_ok.prefer_enhanced is True
	assert quality_ok.degrade_reason is None

	# quality + 302 but deploy forbids external → local path + reason
	quality_blocked = resolve_parse_plan(
		parse_preference="quality",
		mineru_enabled=True,
		mineru_provider="302ai",
		external_parser_allowed=False,
	)
	assert quality_blocked.enhanced_parser_allowed is False
	assert quality_blocked.prefer_enhanced is False
	assert quality_blocked.degrade_reason == "external_parser_forbidden"
	assert quality_blocked.external_processing_allowed is False

	quality_disabled_deploy = resolve_parse_plan(
		parse_preference="quality",
		mineru_enabled=False,
		mineru_provider="self_hosted",
	)
	assert quality_disabled_deploy.degrade_reason == "deploy_mineru_disabled"
	assert quality_disabled_deploy.enhanced_parser_allowed is False

	local_only = resolve_parse_plan(
		parse_preference="local_only",
		mineru_enabled=True,
		mineru_provider="302ai",
		external_parser_allowed=True,
	)
	assert local_only.enhanced_parser_allowed is False
	assert local_only.external_processing_allowed is False

	scan_disabled = resolve_parse_plan(
		parse_preference="quality",
		scan_handling="disabled",
		mineru_enabled=True,
		mineru_provider="self_hosted",
	)
	assert scan_disabled.degrade_reason == "scan_handling_disabled"
	assert scan_disabled.enhanced_parser_allowed is False

	external_ok = resolve_parse_plan(
		parse_preference="auto",
		mineru_enabled=True,
		mineru_provider="302ai",
		external_parser_allowed=True,
	)
	assert external_ok.external_processing_allowed is True


def test_ask_policy_snapshot_shape() -> None:
	snap = resolve_ask_policy(PUBLIC_ASK_DEFAULTS, policy_version=3).snapshot()
	assert snap["public"]["answer_profile"] == "balanced"
	assert "hybrid_enabled" in snap["resolved"]
	assert snap["policy_version"] == 3
