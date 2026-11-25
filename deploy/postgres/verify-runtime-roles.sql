\set ON_ERROR_STOP on
\getenv dbos_database UNORAG_DBOS_DATABASE

-- PostgreSQL treats a comma-separated privilege list as "any", not "all".
DO $runtime_table_privileges$
BEGIN
	IF NOT has_table_privilege('unorag_web_login', 'app.users', 'SELECT')
		OR NOT has_table_privilege('unorag_web_login', 'app.users', 'INSERT')
		OR NOT has_table_privilege('unorag_web_login', 'app.users', 'UPDATE')
		OR NOT has_table_privilege('unorag_web_login', 'app.users', 'DELETE')
		OR NOT has_table_privilege('unorag_web_login', 'app.organization_model_settings', 'SELECT')
		OR NOT has_table_privilege('unorag_web_login', 'app.organization_model_settings', 'INSERT')
		OR NOT has_table_privilege('unorag_web_login', 'app.organization_model_settings', 'UPDATE')
		OR has_table_privilege('unorag_web_login', 'app.organization_model_settings', 'DELETE')
		OR has_schema_privilege('unorag_web_login', 'app', 'CREATE') THEN
		RAISE EXCEPTION 'unorag_web_login privilege boundary is invalid';
	END IF;
	IF NOT has_table_privilege('unorag_worker_login', 'app.jobs', 'SELECT')
		OR NOT has_table_privilege('unorag_worker_login', 'app.jobs', 'INSERT')
		OR NOT has_table_privilege('unorag_worker_login', 'app.jobs', 'UPDATE')
		OR NOT has_table_privilege('unorag_worker_login', 'app.document_figure_assets', 'SELECT')
		OR NOT has_table_privilege('unorag_worker_login', 'app.document_figure_assets', 'INSERT')
		OR NOT has_table_privilege('unorag_worker_login', 'app.document_figure_assets', 'UPDATE')
		OR NOT has_table_privilege('unorag_worker_login', 'app.document_figure_assets', 'DELETE')
		OR NOT has_table_privilege('unorag_worker_login', 'app.generation_cleanup_queue', 'SELECT')
		OR NOT has_table_privilege('unorag_worker_login', 'app.generation_cleanup_queue', 'INSERT')
		OR NOT has_table_privilege('unorag_worker_login', 'app.generation_cleanup_queue', 'UPDATE')
		OR NOT has_table_privilege('unorag_worker_login', 'app.generation_cleanup_queue', 'DELETE')
		OR NOT has_table_privilege('unorag_worker_login', 'app.active_document_generations', 'SELECT')
		OR NOT has_table_privilege('unorag_worker_login', 'app.ask_run_stages', 'SELECT')
		OR NOT has_table_privilege('unorag_worker_login', 'app.job_stage_runs', 'SELECT')
		OR NOT has_table_privilege('unorag_worker_login', 'app.audit_logs', 'SELECT')
		OR NOT has_table_privilege('unorag_worker_login', 'app.audit_logs', 'INSERT')
		OR NOT has_table_privilege('unorag_worker_login', 'app.observability_alerts', 'SELECT')
		OR NOT has_table_privilege('unorag_worker_login', 'app.observability_alerts', 'INSERT')
		OR NOT has_table_privilege('unorag_worker_login', 'app.observability_alerts', 'UPDATE')
		OR NOT has_table_privilege('unorag_worker_login', 'app.observability_alert_transitions', 'SELECT')
		OR NOT has_table_privilege('unorag_worker_login', 'app.observability_alert_transitions', 'INSERT')
		OR NOT has_table_privilege('unorag_worker_login', 'app.observability_alert_deliveries', 'SELECT')
		OR NOT has_table_privilege('unorag_worker_login', 'app.observability_alert_deliveries', 'INSERT')
		OR NOT has_table_privilege('unorag_worker_login', 'app.observability_alert_deliveries', 'UPDATE')
		OR NOT has_table_privilege('unorag_worker_login', 'app.observability_component_health', 'SELECT')
		OR NOT has_table_privilege('unorag_worker_login', 'app.observability_component_health', 'INSERT')
		OR NOT has_table_privilege('unorag_worker_login', 'app.observability_component_health', 'UPDATE')
		OR has_table_privilege('unorag_worker_login', 'app.users', 'SELECT')
		OR has_table_privilege('unorag_worker_login', 'app.organization_model_settings', 'SELECT')
		OR has_schema_privilege('unorag_worker_login', 'app', 'CREATE') THEN
		RAISE EXCEPTION 'unorag_worker_login privilege boundary is invalid';
	END IF;
END $runtime_table_privileges$;

DO $$
BEGIN
	IF has_schema_privilege('unorag_dbos_login', 'app', 'USAGE')
		OR has_database_privilege('unorag_dbos_login', current_database(), 'CONNECT') THEN
		RAISE EXCEPTION 'unorag_dbos_login can access application data';
	END IF;
	IF EXISTS (
		SELECT 1 FROM pg_roles
		WHERE rolname IN ('unorag_web_login', 'unorag_worker_login', 'unorag_dbos_login')
			AND (rolsuper OR rolcreatedb OR rolcreaterole)
	) THEN
		RAISE EXCEPTION 'a runtime login has administrative attributes';
	END IF;
END $$;

SELECT EXISTS (
	SELECT 1
	FROM pg_database AS database
	JOIN pg_roles AS owner ON owner.oid = database.datdba
	WHERE database.datname = :'dbos_database'
		AND owner.rolname = 'unorag_dbos_login'
) AS dbos_database_owner_valid \gset
\if :dbos_database_owner_valid
\else
	DO $$ BEGIN RAISE EXCEPTION 'DBOS system database is missing or has the wrong owner'; END $$;
\endif

SELECT 'runtime role verification passed' AS result;
