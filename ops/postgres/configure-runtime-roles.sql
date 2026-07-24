\set ON_ERROR_STOP on

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meriknow_migrator') THEN
		CREATE ROLE meriknow_migrator NOLOGIN;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meriknow_web') THEN
		CREATE ROLE meriknow_web NOLOGIN;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meriknow_worker') THEN
		CREATE ROLE meriknow_worker NOLOGIN;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meriknow_rag_read') THEN
		CREATE ROLE meriknow_rag_read NOLOGIN;
	END IF;
END $$;

GRANT USAGE ON SCHEMA app TO meriknow_web, meriknow_worker, meriknow_rag_read;
GRANT USAGE ON SCHEMA rag TO meriknow_worker, meriknow_rag_read;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA app TO meriknow_migrator;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA app TO meriknow_migrator;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO meriknow_web;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO meriknow_web;

GRANT SELECT ON
	app.jobs,
	app.documents,
	app.document_versions,
	app.document_active_versions,
	app.document_acl,
	app.libraries
TO meriknow_worker;

GRANT UPDATE (
	status,
	stage,
	progress,
	progress_current,
	progress_total,
	attempt,
	next_attempt_at,
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
	started_at,
	finished_at,
	updated_at
) ON app.jobs TO meriknow_worker;

GRANT UPDATE (
	status,
	parser_backend,
	chunk_profile,
	parser_report,
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
) ON app.document_versions TO meriknow_worker;

GRANT UPDATE (
	status,
	desired_version_id,
	latest_job_id,
	deleted_at,
	updated_at
) ON app.documents TO meriknow_worker;

GRANT UPDATE (
	status,
	ready_count,
	updated_at
) ON app.libraries TO meriknow_worker;

GRANT INSERT, UPDATE, DELETE ON app.document_active_versions TO meriknow_worker;
GRANT INSERT ON app.audit_logs, app.outbox_events TO meriknow_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON
	rag.active_document_generations,
	rag.generation_cleanup_queue
TO meriknow_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO meriknow_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA rag TO meriknow_worker;

GRANT SELECT ON
	app.documents,
	app.document_versions,
	app.document_active_versions,
	app.document_acl,
	app.libraries
TO meriknow_rag_read;

GRANT SELECT ON rag.active_document_generations TO meriknow_rag_read;

-- Login roles are deployment-specific. Operators create them with customer
-- secret policy, then grant exactly one runtime role:
--   GRANT meriknow_web TO <web_login>;
--   GRANT meriknow_worker TO <worker_login>;
--   GRANT meriknow_rag_read TO <rag_api_login>;
