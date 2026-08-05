\set ON_ERROR_STOP on
\getenv dbos_database UNORAG_DBOS_DATABASE

DO $$
BEGIN
	IF NOT has_table_privilege('unorag_web_login', 'app.users', 'SELECT,INSERT,UPDATE,DELETE')
		OR has_schema_privilege('unorag_web_login', 'app', 'CREATE') THEN
		RAISE EXCEPTION 'unorag_web_login privilege boundary is invalid';
	END IF;
	IF NOT has_table_privilege('unorag_worker_login', 'app.jobs', 'SELECT,INSERT,UPDATE')
		OR NOT has_table_privilege('unorag_worker_login', 'app.generation_cleanup_queue', 'SELECT,INSERT,UPDATE,DELETE')
		OR NOT has_table_privilege('unorag_worker_login', 'app.active_document_generations', 'SELECT')
		OR NOT has_table_privilege('unorag_worker_login', 'app.observability_alerts', 'SELECT,INSERT,UPDATE')
		OR NOT has_table_privilege('unorag_worker_login', 'app.observability_alert_transitions', 'SELECT,INSERT')
		OR NOT has_table_privilege('unorag_worker_login', 'app.observability_alert_deliveries', 'SELECT,INSERT,UPDATE')
		OR NOT has_table_privilege('unorag_worker_login', 'app.observability_component_health', 'SELECT,INSERT,UPDATE')
		OR has_table_privilege('unorag_worker_login', 'app.users', 'SELECT')
		OR has_schema_privilege('unorag_worker_login', 'app', 'CREATE') THEN
		RAISE EXCEPTION 'unorag_worker_login privilege boundary is invalid';
	END IF;
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
