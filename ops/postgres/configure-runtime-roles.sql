\set ON_ERROR_STOP on

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_migrator') THEN
		CREATE ROLE unorag_migrator NOLOGIN;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_web') THEN
		CREATE ROLE unorag_web NOLOGIN;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_worker') THEN
		CREATE ROLE unorag_worker NOLOGIN;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_api') THEN
		CREATE ROLE unorag_api NOLOGIN;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_outbox') THEN
		CREATE ROLE unorag_outbox NOLOGIN;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_rag_read') THEN
		CREATE ROLE unorag_rag_read NOLOGIN;
	END IF;
END $$;

REVOKE ALL PRIVILEGES ON SCHEMA app, rag, public FROM
	unorag_web,
	unorag_api,
	unorag_worker,
	unorag_outbox,
	unorag_rag_read;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA app, rag, public FROM
	unorag_web,
	unorag_api,
	unorag_worker,
	unorag_outbox,
	unorag_rag_read;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA app, rag, public FROM
	unorag_web,
	unorag_api,
	unorag_worker,
	unorag_outbox,
	unorag_rag_read;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app, rag FROM PUBLIC;

GRANT USAGE ON SCHEMA app TO
	unorag_web,
	unorag_worker,
	unorag_outbox,
	unorag_rag_read;
GRANT USAGE ON SCHEMA rag TO unorag_worker, unorag_rag_read;
GRANT USAGE ON SCHEMA public TO unorag_api, unorag_worker;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA app TO unorag_migrator;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA app TO unorag_migrator;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO unorag_web;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO unorag_web;

GRANT SELECT ON
	app.jobs,
	app.documents,
	app.document_versions,
	app.document_active_versions,
	app.document_acl,
	app.libraries
TO unorag_worker;

GRANT UPDATE (
	status,
	stage,
	progress,
	progress_current,
	progress_total,
	attempt,
	next_attempt_at,
	payload,
	result,
	error_code,
	error,
	claimed_by,
	claimed_at,
	lease_token,
	lease_expires_at,
	heartbeat_at,
	cancel_requested_at,
	worker_version,
	workflow_id,
	dispatched_at,
	started_at,
	finished_at,
	updated_at
) ON app.jobs TO unorag_worker;

GRANT INSERT (
	id,
	organization_id,
	workspace_id,
	document_version_id,
	type,
	execution_engine,
	workflow_id,
	status,
	stage,
	idempotency_key,
	payload
) ON app.jobs TO unorag_worker;

GRANT UPDATE (
	status,
	parser_backend,
	chunk_profile,
	parser_report,
	ingest_policy_version,
	document_profile,
	scan_handling,
	parse_preference,
	point_count,
	chunk_count,
	section_count,
	table_count,
	failure_code,
	error,
	indexed_at,
	activated_at,
	superseded_at,
	updated_at
) ON app.document_versions TO unorag_worker;

GRANT UPDATE (
	status,
	acl_fingerprint,
	projected_acl_fingerprint,
	desired_version_id,
	latest_job_id,
	deleted_at,
	updated_at
) ON app.documents TO unorag_worker;

GRANT UPDATE (
	status,
	doc_count,
	ready_count,
	applied_document_profile,
	updated_at
) ON app.libraries TO unorag_worker;

GRANT INSERT, UPDATE, DELETE ON app.document_active_versions TO unorag_worker;
GRANT INSERT ON app.audit_logs, app.outbox_events TO unorag_worker;
-- ON CONFLICT (idempotency_key) needs read access to the conflict target.
-- Keep this column-scoped so the worker cannot inspect unrelated outbox payloads.
GRANT SELECT (idempotency_key) ON app.outbox_events TO unorag_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON
	rag.active_document_generations,
	rag.generation_cleanup_queue
TO unorag_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO unorag_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA rag TO unorag_worker;

-- The lifecycle worker only removes the legacy public.* document projection
-- after authoritative app.* cleanup. It cannot read threads or turns.
GRANT SELECT, DELETE ON public.documents TO unorag_worker;
GRANT SELECT ON public.libraries TO unorag_worker;
GRANT UPDATE (status, doc_count, ready_count, updated_at)
ON public.libraries TO unorag_worker;

GRANT SELECT, INSERT, UPDATE, DELETE ON
	public.libraries,
	public.documents,
	public.threads,
	public.turns
TO unorag_api;

GRANT SELECT, UPDATE ON app.outbox_events TO unorag_outbox;

GRANT SELECT (
	id,
	organization_id,
	workspace_id,
	status,
	acl_fingerprint,
	projected_acl_fingerprint
) ON app.documents TO unorag_rag_read;

GRANT SELECT ON
	app.document_versions,
	app.document_active_versions,
	app.document_acl,
	app.libraries
TO unorag_rag_read;

GRANT SELECT ON rag.active_document_generations TO unorag_rag_read;

-- Login roles are deployment-specific. Operators create them with customer
-- secret policy, then grant exactly one runtime role:
--   GRANT unorag_web TO <web_login>;
--   GRANT unorag_api TO <api_login>;
--   GRANT unorag_worker TO <worker_login>;
--   GRANT unorag_outbox TO <outbox_login>;
--   GRANT unorag_rag_read TO <rag_api_login>;
