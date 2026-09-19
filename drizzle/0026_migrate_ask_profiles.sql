WITH legacy_settings AS (
	SELECT
		workspace_id,
		ask,
		CASE
			WHEN jsonb_typeof(ask -> 'retrieve_top_k') = 'number'
				THEN trunc((ask ->> 'retrieve_top_k')::numeric)
			WHEN jsonb_typeof(ask -> 'retrieve_top_k') = 'string'
				AND ask ->> 'retrieve_top_k' ~ '^\s*[+-]?[0-9]+(?:\.[0-9]+)?\s*$'
				THEN trunc((ask ->> 'retrieve_top_k')::numeric)
			ELSE 6
		END AS top_k,
		CASE
			WHEN jsonb_typeof(ask -> 'answer_min_score') = 'number'
				THEN (ask ->> 'answer_min_score')::numeric
			WHEN jsonb_typeof(ask -> 'answer_min_score') = 'string'
				AND ask ->> 'answer_min_score' ~ '^\s*[+-]?[0-9]+(?:\.[0-9]+)?\s*$'
				THEN (ask ->> 'answer_min_score')::numeric
			ELSE 0.4
		END AS min_score,
		CASE
			WHEN jsonb_typeof(ask -> 'citation_adjudicate_absolute_floor') = 'number'
				THEN (ask ->> 'citation_adjudicate_absolute_floor')::numeric
			WHEN jsonb_typeof(ask -> 'citation_adjudicate_absolute_floor') = 'string'
				AND ask ->> 'citation_adjudicate_absolute_floor' ~ '^\s*[+-]?[0-9]+(?:\.[0-9]+)?\s*$'
				THEN (ask ->> 'citation_adjudicate_absolute_floor')::numeric
			ELSE 0.35
		END AS evidence_floor
	FROM app.workspace_settings
	WHERE NOT (ask ?| ARRAY['answer_profile', 'retrieval_enhancement', 'evidence_requirement'])
		AND ask ?| ARRAY[
			'retrieve_top_k',
			'answer_min_score',
			'hybrid_enabled',
			'rerank_enabled',
			'citation_adjudicate_enabled',
			'citation_adjudicate_absolute_floor',
			'session_memory_max_turns'
		]
), mapped_settings AS (
	SELECT
		workspace_id,
		ask AS previous_ask,
		jsonb_build_object(
			'answer_profile', CASE
				WHEN min_score >= 0.5 OR top_k <= 4 THEN 'precise'
				WHEN min_score <= 0.3 OR top_k >= 9 THEN 'exploratory'
				ELSE 'balanced'
			END,
			'retrieval_enhancement', CASE
				WHEN ask -> 'hybrid_enabled' = 'true'::jsonb
					AND ask -> 'rerank_enabled' = 'true'::jsonb THEN 'on'
				WHEN ask -> 'hybrid_enabled' = 'false'::jsonb
					AND ask -> 'rerank_enabled' = 'false'::jsonb THEN 'off'
				WHEN NOT (ask ? 'hybrid_enabled') AND NOT (ask ? 'rerank_enabled') THEN 'auto'
				WHEN ask -> 'hybrid_enabled' = 'true'::jsonb
					OR ask -> 'rerank_enabled' = 'true'::jsonb THEN 'on'
				ELSE 'off'
			END,
			'session_memory_enabled', CASE
				WHEN jsonb_typeof(ask -> 'session_memory_enabled') = 'boolean'
					THEN ask -> 'session_memory_enabled'
				ELSE 'true'::jsonb
			END,
			'evidence_requirement', CASE
				WHEN ask -> 'citation_adjudicate_enabled' = 'false'::jsonb
					OR evidence_floor <= 0.28 THEN 'relaxed'
				WHEN evidence_floor >= 0.4 OR min_score >= 0.5 THEN 'strict'
				ELSE 'standard'
			END
		) AS public_ask
	FROM legacy_settings
)
UPDATE app.workspace_settings AS settings
SET
	ask_previous = COALESCE(settings.ask_previous, mapped.previous_ask),
	ask = mapped.public_ask,
	policy_version = settings.policy_version + 1,
	updated_at = now()
FROM mapped_settings AS mapped
WHERE settings.workspace_id = mapped.workspace_id;
